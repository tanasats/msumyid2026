import { X509Certificate, createPrivateKey, generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { loadCa, type CaInfo } from './ca.js';
import { AppError } from '../errors.js';
import { openPrivateKey, sealPrivateKey, type SealedKey } from './escrow.js';
import { runOpenssl } from './openssl.js';

// ออกใบรับรอง S/MIME ให้ผู้ใช้ด้วย OpenSSL CLI — extensions เหมือน [ smime ] ใน intermediate.cnf ของระบบเดิมทุกตัว
// ต่างจากสคริปต์เดิม: private key ไม่ถูกเขียนลงดิสก์แบบไม่เข้ารหัส, รหัสผ่านไม่อยู่ใน argument, ระบบไม่เก็บรหัสผ่าน .p12

const generateKeyPairAsync = promisify(generateKeyPair);

export type IssueInput = {
  commonName: string;
  email: string;
  /** รหัสผ่านของไฟล์ .p12 ที่ผู้ใช้ตั้งเอง (ไม่เก็บ) */
  p12Password: string;
  /** true = เข้ารหัส .p12 แบบ 3DES/SHA-1 ให้โปรแกรมรุ่นเก่าเปิดได้ (ค่าเริ่มต้นของ OpenSSL 3 คือ AES-256) */
  legacyP12: boolean;
};

export type IssuedCertificate = {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  p12: Buffer;
  escrow: SealedKey;
};

/** serial สุ่ม 128 บิตแบบเดียวกับ openssl rand -hex 16 ของระบบเดิม (บิตบนสุดเป็น 0 ให้เป็นจำนวนบวกเสมอ) */
function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x01;
  return bytes.toString('hex');
}

/** serial ฐาน 16 ตัวพิมพ์เล็ก ไม่มีเลข 0 นำหน้า (รูปแบบที่เก็บในฐานข้อมูล) */
export function normalizeSerial(hex: string): string {
  return hex.toLowerCase().replace(/^0+(?=.)/, '');
}

/**
 * ค่าในไฟล์ config ของ OpenSSL: ใส่ \ หน้าอักขระพิเศษ ($ = แทนค่าตัวแปร, # = คอมเมนต์, \ และเครื่องหมายคำพูด)
 * ใช้ไฟล์ config แทน -subj เพราะชื่อภาษาไทยใน argument อาจเพี้ยนบน Windows และ / ใน -subj คือตัวคั่น
 */
function confValue(value: string): string {
  return value.replace(/[\\$#"']/g, (c) => `\\${c}`);
}

function requestConfig(ca: CaInfo, input: IssueInput): string {
  return [
    '[ req ]',
    'prompt = no',
    'distinguished_name = dn',
    // ชื่อไทยเก็บเป็น UTF8String (เหมือน string_mask = utf8only และ -utf8 ของระบบเดิม)
    'string_mask = utf8only',
    'utf8 = yes',
    '',
    '[ dn ]',
    `C = ${confValue(ca.country)}`,
    `O = ${confValue(ca.organization)}`,
    `CN = ${confValue(input.commonName)}`,
    `emailAddress = ${confValue(input.email)}`,
    '',
  ].join('\n');
}

function extensionsConfig(): string {
  return [
    '[ smime ]',
    'basicConstraints = CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    'subjectAltName = email:copy',
    'extendedKeyUsage = emailProtection',
    'crlDistributionPoints = @crl_info',
    '',
    '[ crl_info ]',
    `URI.0 = ${confValue(config.crlDistributionUrl)}`,
    '',
  ].join('\n');
}

/** ทำงานในโฟลเดอร์ชั่วคราวแล้วลบทิ้งเสมอ (แม้ล้มเหลว) */
async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'msumyid-signer-'));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * เขียน private key ลงไฟล์ชั่วคราวแบบเข้ารหัส (passphrase สุ่มใช้ครั้งเดียว) ให้ OpenSSL อ่านผ่าน -passin env:
 * คืน passphrase ที่ใช้
 */
async function writeEncryptedKey(file: string, privateKey: KeyObject): Promise<string> {
  const passphrase = randomBytes(32).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  await writeFile(file, pem, { mode: 0o600 });
  return passphrase;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * อายุใบ (วัน) = CERT_VALIDITY_DAYS แต่ไม่เกินวันหมดอายุที่เร็วที่สุดในสายของ CA
 * (ใบที่หมดอายุช้ากว่า CA/root จะตรวจสายไม่ผ่านตั้งแต่วันที่ CA หมดอายุ) — เหลือไม่ถึง 1 วัน = ออกใบไม่ได้
 */
export function validityDays(caNotAfter: Date, now: Date, configuredDays: number): number {
  const days = Math.min(configuredDays, Math.floor((caNotAfter.getTime() - now.getTime()) / DAY_MS));
  if (days < 1) {
    throw new AppError(503, 'CA_EXPIRING', 'ใบรับรองของ CA หมดอายุหรือใกล้หมดอายุ ออกใบรับรองใหม่ไม่ได้');
  }
  return days;
}

/** รวม private key + ใบรับรอง + ใบของ Intermediate CA (และ root ถ้าตั้ง CA_CHAIN_PATH) เป็น .p12 ที่ล็อกด้วยรหัสผ่านของผู้ใช้ */
export async function buildP12(input: {
  privateKey: KeyObject;
  certificatePem: string;
  password: string;
  legacy: boolean;
}): Promise<Buffer> {
  const ca = await loadCa();
  return withTempDir(async (dir) => {
    const keyFile = path.join(dir, 'key.pem');
    const certFile = path.join(dir, 'cert.pem');
    const chainFile = path.join(dir, 'chain.pem');
    const p12File = path.join(dir, 'out.p12');
    const keyPass = await writeEncryptedKey(keyFile, input.privateKey);
    await writeFile(certFile, input.certificatePem);
    await writeFile(chainFile, ca.bundlePem);

    const args = ['pkcs12', '-export', '-inkey', keyFile, '-passin', 'env:KEY_PASS'];
    args.push('-in', certFile, '-certfile', chainFile, '-passout', 'env:P12_PASS', '-out', p12File);
    if (input.legacy) {
      args.push('-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1');
    }
    await runOpenssl(config.opensslBin, args, { secrets: { KEY_PASS: keyPass, P12_PASS: input.password } });
    return readFile(p12File);
  });
}

/** สร้าง key ใหม่ → CSR → CA เซ็น → .p12 + key สำรองที่เข้ารหัสแล้ว */
export async function issueCertificate(input: IssueInput): Promise<IssuedCertificate> {
  const ca = await loadCa();
  const days = validityDays(ca.notAfter, new Date(), config.certValidityDays);
  const { privateKey } = await generateKeyPairAsync('rsa', { modulusLength: config.userKeyBits });
  const serial = randomSerial();

  const certificatePem = await withTempDir(async (dir) => {
    const keyFile = path.join(dir, 'key.pem');
    const reqConfigFile = path.join(dir, 'req.cnf');
    const extFile = path.join(dir, 'ext.cnf');
    const csrFile = path.join(dir, 'req.csr');
    const certFile = path.join(dir, 'cert.pem');

    const keyPass = await writeEncryptedKey(keyFile, privateKey);
    await writeFile(reqConfigFile, requestConfig(ca, input), 'utf8');
    await writeFile(extFile, extensionsConfig(), 'utf8');

    await runOpenssl(
      config.opensslBin,
      ['req', '-new', '-batch', '-utf8', '-config', reqConfigFile, '-key', keyFile, '-passin', 'env:KEY_PASS', '-sha256', '-out', csrFile],
      { secrets: { KEY_PASS: keyPass } },
    );
    // ใช้ x509 -req แทน openssl ca: ฐานข้อมูลของระบบเป็นแหล่งข้อมูลหลักแทน index.txt
    await runOpenssl(
      config.opensslBin,
      [
        'x509', '-req', '-in', csrFile,
        '-CA', ca.certPath, '-CAkey', ca.keyPath, '-passin', 'env:CA_KEY_PASS',
        '-set_serial', `0x${serial}`, '-days', String(days), '-sha256',
        '-extfile', extFile, '-extensions', 'smime', '-out', certFile,
      ],
      { secrets: { CA_KEY_PASS: config.ca.keyPassphrase } },
    );
    return readFile(certFile, 'utf8');
  });

  const cert = new X509Certificate(certificatePem);
  if (!cert.checkIssued(ca.cert) || !cert.checkPrivateKey(privateKey)) {
    throw new Error('ใบรับรองที่ได้ไม่ตรงกับ CA หรือ key ที่สร้าง');
  }
  const serialNumber = normalizeSerial(cert.serialNumber);

  const p12 = await buildP12({ privateKey, certificatePem, password: input.p12Password, legacy: input.legacyP12 });
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  try {
    return {
      certificatePem,
      serialNumber,
      fingerprintSha256: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
      notBefore: new Date(cert.validFrom),
      notAfter: new Date(cert.validTo),
      p12,
      escrow: sealPrivateKey(pkcs8Der, serialNumber),
    };
  } finally {
    pkcs8Der.fill(0);
  }
}

/**
 * กู้ key จากที่สำรองไว้ แล้วสร้าง .p12 ใหม่ด้วยรหัสผ่านใหม่ของผู้ใช้ (ใบรับรองเดิม ไม่ออกใบใหม่)
 * ตรวจก่อนเสมอ: ใบออกโดย CA นี้, serial ตรงกับที่ผูกไว้กับก้อนสำรอง และ key คู่กับใบรับรอง
 * — API ส่งข้อมูลผิดใบมาก็จะไม่ได้ไฟล์ที่รวม key กับใบของคนอื่น
 */
export async function rebuildP12(input: {
  serialNumber: string;
  certificatePem: string;
  escrow: SealedKey;
  p12Password: string;
  legacyP12: boolean;
}): Promise<Buffer> {
  const ca = await loadCa();
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(input.certificatePem);
  } catch {
    throw new AppError(422, 'CERTIFICATE_INVALID', 'ใบรับรองไม่ถูกต้อง');
  }
  if (!cert.checkIssued(ca.cert) || !cert.verify(ca.cert.publicKey)) {
    throw new AppError(422, 'CERTIFICATE_NOT_ISSUED_BY_CA', 'ใบรับรองนี้ไม่ได้ออกโดย CA ของระบบ');
  }
  if (normalizeSerial(cert.serialNumber) !== input.serialNumber) {
    throw new AppError(422, 'SERIAL_MISMATCH', 'serial ไม่ตรงกับใบรับรอง');
  }

  let pkcs8Der: Buffer;
  try {
    pkcs8Der = openPrivateKey(input.escrow, input.serialNumber);
  } catch {
    // ก้อนสำรองถูกแก้ / ผิดใบ / KEK ไม่ตรง — ไม่บอกรายละเอียด
    throw new AppError(422, 'ESCROW_INVALID', 'ถอด key สำรองไม่ได้');
  }
  try {
    const privateKey = createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
    if (!cert.checkPrivateKey(privateKey)) {
      throw new AppError(422, 'KEY_MISMATCH', 'key สำรองไม่คู่กับใบรับรอง');
    }
    return await buildP12({
      privateKey,
      certificatePem: input.certificatePem,
      password: input.p12Password,
      legacy: input.legacyP12,
    });
  } finally {
    pkcs8Der.fill(0);
  }
}

/**
 * นำ key เดิมจากระบบสคริปต์ (private/<อีเมล>.key.pem เข้ารหัสด้วยรหัสผ่านจาก pkcs12-files.csv) มาเก็บเป็น key สำรอง
 * - ลองรหัสผ่านทีละตัว (อีเมลเดียวอาจมีหลายบรรทัดใน CSV เมื่อเคยออกใบซ้ำ)
 * - จับคู่กับใบรับรองด้วย public key (สคริปต์เดิมเขียนทับ key ทุกครั้งที่ออกใบใหม่ จึงไม่รู้ล่วงหน้าว่าเป็นของใบไหน)
 * - ใบต้องออกโดย CA นี้ — คืน serial ของใบที่คู่กันพร้อม key สำรองที่ผูกกับ serial นั้น
 */
export async function escrowLegacyKey(input: {
  privateKeyPem: string;
  passphrases: string[];
  certificates: { serialNumber: string; certificatePem: string }[];
}): Promise<{ serialNumber: string; escrow: SealedKey }> {
  const ca = await loadCa();
  let privateKey: KeyObject | null = null;
  for (const passphrase of input.passphrases) {
    try {
      privateKey = createPrivateKey({ key: input.privateKeyPem, passphrase });
      break;
    } catch {
      // รหัสผ่านไม่ถูก ลองตัวถัดไป
    }
  }
  if (!privateKey) {
    throw new AppError(422, 'KEY_DECRYPT_FAILED', 'ถอดรหัส key ด้วยรหัสผ่านที่ให้มาไม่ได้');
  }

  for (const candidate of input.certificates) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(candidate.certificatePem);
    } catch {
      continue;
    }
    if (normalizeSerial(cert.serialNumber) !== candidate.serialNumber) continue;
    if (!cert.checkIssued(ca.cert) || !cert.verify(ca.cert.publicKey)) continue;
    if (!cert.checkPrivateKey(privateKey)) continue;

    const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
    try {
      return { serialNumber: candidate.serialNumber, escrow: sealPrivateKey(pkcs8Der, candidate.serialNumber) };
    } finally {
      pkcs8Der.fill(0);
    }
  }
  throw new AppError(422, 'KEY_NO_MATCHING_CERTIFICATE', 'key นี้ไม่คู่กับใบรับรองใดที่ส่งมา');
}
