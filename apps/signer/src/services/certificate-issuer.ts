import { X509Certificate, generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { loadCa, type CaInfo } from './ca.js';
import { sealPrivateKey, type SealedKey } from './escrow.js';
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

/** รวม private key + ใบรับรอง + ใบของ Intermediate CA เป็น .p12 ที่ล็อกด้วยรหัสผ่านของผู้ใช้ */
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
    const p12File = path.join(dir, 'out.p12');
    const keyPass = await writeEncryptedKey(keyFile, input.privateKey);
    await writeFile(certFile, input.certificatePem);

    const args = ['pkcs12', '-export', '-inkey', keyFile, '-passin', 'env:KEY_PASS'];
    args.push('-in', certFile, '-certfile', ca.certPath, '-passout', 'env:P12_PASS', '-out', p12File);
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
        '-set_serial', `0x${serial}`, '-days', String(config.certValidityDays), '-sha256',
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
