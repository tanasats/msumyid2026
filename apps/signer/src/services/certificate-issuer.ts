import { X509Certificate, createPrivateKey, generateKeyPair, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { loadCa, type CaInfo } from './ca.js';
import { AppError } from '../errors.js';
import { openPrivateKey, sealPrivateKey, type SealedKey } from './escrow.js';
import { asn1Time, confPath, evenHex, runOpenssl, supportsCmsCades } from './openssl.js';

// ออกใบรับรองให้ผู้ใช้ด้วย OpenSSL CLI — 2 โปรไฟล์ (docs/design/certificates.md หัวข้อ "ใบประจำตัว / ใบเสริม / นโยบายอายุ")
//   smime            = ใบประจำตัว: extensions เหมือน [ smime ] ใน intermediate.cnf ของระบบเดิมทุกตัว
//   document_signing = ใบเสริม: ลงนามเอกสารเท่านั้น (ไม่มี emailProtection โปรแกรมอีเมลจึงไม่ใช้ใบนี้) กำหนดช่วงเวลาเองได้
// ต่างจากสคริปต์เดิม: private key ไม่ถูกเขียนลงดิสก์แบบไม่เข้ารหัส, รหัสผ่านไม่อยู่ใน argument, ระบบไม่เก็บรหัสผ่าน .p12

const generateKeyPairAsync = promisify(generateKeyPair);

export type CertificateProfile = 'smime' | 'document_signing';

type IssueBase = {
  commonName: string;
  email: string;
  /** รหัสผ่านของไฟล์ .p12 ที่ผู้ใช้ตั้งเอง (ไม่เก็บ) */
  p12Password: string;
  /** true = เข้ารหัส .p12 แบบ 3DES/SHA-1 ให้โปรแกรมรุ่นเก่าเปิดได้ (ค่าเริ่มต้นของ OpenSSL 3 คือ AES-256) */
  legacyP12: boolean;
};

export type IssueInput = IssueBase &
  (
    | {
        profile?: 'smime';
        /** อายุใบ (วัน) ตามนโยบายของ API — ไม่ส่ง = ใช้เพดาน CERT_VALIDITY_DAYS; ไม่เกินเพดานและอายุ CA เสมอ */
        validityDays?: number;
      }
    | {
        profile: 'document_signing';
        /** ช่วงเวลาที่อนุมัติ — ถูกตัดตาม documentSigningWindow() */
        notBefore: Date;
        notAfter: Date;
      }
  );

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

/** ชื่อ section ของ extensions ตามโปรไฟล์ */
const EXTENSION_SECTION: Record<CertificateProfile, string> = { smime: 'smime', document_signing: 'document_signing' };

function extensionsConfig(): string {
  const common = [
    'basicConstraints = CA:FALSE',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    'subjectAltName = email:copy',
    'crlDistributionPoints = @crl_info',
  ];
  return [
    '[ smime ]',
    ...common,
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = emailProtection',
    '',
    // ลงนามเอกสาร: nonRepudiation = ผู้ลงนามปฏิเสธไม่ได้, ไม่มี keyEncipherment (ไม่ใช้เข้ารหัส)
    // EKU ที่ Acrobat/Foxit ยอมรับ: documentSigning (RFC 9336), Microsoft Document Signing, Adobe Authentic Documents Trust
    '[ document_signing ]',
    ...common,
    'keyUsage = critical, digitalSignature, nonRepudiation',
    'extendedKeyUsage = 1.3.6.1.5.5.7.3.36, 1.3.6.1.4.1.311.10.3.12, 1.2.840.113583.1.1.5',
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
 * อายุใบ (วัน) = ค่าที่ขอ (ไม่เกินเพดาน CERT_VALIDITY_DAYS) แต่ไม่เกินวันหมดอายุที่เร็วที่สุดในสายของ CA
 * (ใบที่หมดอายุช้ากว่า CA/root จะตรวจสายไม่ผ่านตั้งแต่วันที่ CA หมดอายุ) — เหลือไม่ถึง 1 วัน = ออกใบไม่ได้
 */
export function validityDays(caNotAfter: Date, now: Date, maxDays: number, requestedDays = maxDays): number {
  const days = Math.min(requestedDays, maxDays, Math.floor((caNotAfter.getTime() - now.getTime()) / DAY_MS));
  if (days < 1) {
    throw new AppError(503, 'CA_EXPIRING', 'ใบรับรองของ CA หมดอายุหรือใกล้หมดอายุ ออกใบรับรองใหม่ไม่ได้');
  }
  return days;
}

/**
 * ช่วงเวลาของใบเสริม: เริ่มไม่ก่อนเวลาปัจจุบัน (ไม่ออกใบย้อนหลัง) และสิ้นสุดไม่เกินที่ขอ, เพดาน CERT_VALIDITY_DAYS และอายุของ CA
 * ช่วงที่เหลือหมดแล้ว = ปฏิเสธ (API ตรวจก่อนอยู่แล้ว ตรงนี้กันข้อมูลผิดพลาด)
 */
export function documentSigningWindow(
  caNotAfter: Date,
  now: Date,
  maxDays: number,
  requested: { notBefore: Date; notAfter: Date },
): { notBefore: Date; notAfter: Date } {
  if (caNotAfter.getTime() - now.getTime() < DAY_MS) {
    throw new AppError(503, 'CA_EXPIRING', 'ใบรับรองของ CA หมดอายุหรือใกล้หมดอายุ ออกใบรับรองใหม่ไม่ได้');
  }
  // ตัดเศษมิลลิวินาที เพราะเวลาในใบรับรองละเอียดถึงวินาที
  const start = Math.floor(Math.max(requested.notBefore.getTime(), now.getTime()) / 1000) * 1000;
  const end = Math.floor(Math.min(requested.notAfter.getTime(), caNotAfter.getTime(), start + maxDays * DAY_MS) / 1000) * 1000;
  if (end <= start) {
    throw new AppError(422, 'VALIDITY_INVALID', 'ช่วงเวลาของใบรับรองสิ้นสุดแล้ว');
  }
  return { notBefore: new Date(start), notAfter: new Date(end) };
}

/**
 * ให้ CA เซ็น CSR ด้วย openssl ca กับฐานข้อมูลชั่วคราว (แบบเดียวกับการออก CRL) เพราะกำหนดวันเริ่มได้ทุกเวอร์ชัน
 * (x509 -req กำหนดวันเริ่มได้ตั้งแต่ OpenSSL 3.4 แต่เครื่อง dev ใช้ 3.2) — ฐานข้อมูลของระบบยังเป็นแหล่งข้อมูลหลัก
 */
async function signWithCa(
  dir: string,
  ca: CaInfo,
  input: { csrFile: string; extFile: string; section: string; serial: string; notBefore: Date; notAfter: Date; outFile: string },
): Promise<void> {
  const file = (name: string) => path.join(dir, name);
  await writeFile(file('index.txt'), '');
  await writeFile(file('serial'), `${evenHex(input.serial)}\n`);
  await writeFile(
    file('ca.cnf'),
    [
      '[ ca ]',
      'default_ca = CA_default',
      '',
      '[ CA_default ]',
      `database = ${confPath(file('index.txt'))}`,
      `serial = ${confPath(file('serial'))}`,
      `new_certs_dir = ${confPath(dir)}`,
      `certificate = ${confPath(ca.certPath)}`,
      `private_key = ${confPath(ca.keyPath)}`,
      'default_md = sha256',
      'unique_subject = no',
      'email_in_dn = yes',
      'copy_extensions = none',
      'string_mask = utf8only',
      'policy = policy_any',
      '',
      // subject มาจาก CSR ที่ signer สร้างเอง — ไม่ต้องบังคับค่า แค่เก็บทุกช่องตามลำดับเดิม (-preserveDN)
      '[ policy_any ]',
      'countryName = optional',
      'organizationName = optional',
      'commonName = supplied',
      'emailAddress = optional',
      '',
    ].join('\n'),
  );
  await runOpenssl(
    config.opensslBin,
    [
      'ca', '-batch', '-notext', '-preserveDN', '-utf8', '-config', file('ca.cnf'), '-passin', 'env:CA_KEY_PASS',
      '-in', input.csrFile, '-extfile', input.extFile, '-extensions', input.section,
      '-startdate', asn1Time(input.notBefore, 'generalized'), '-enddate', asn1Time(input.notAfter, 'generalized'),
      '-out', input.outFile,
    ],
    { secrets: { CA_KEY_PASS: config.ca.keyPassphrase } },
  );
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
  const now = new Date();
  const profile: CertificateProfile = input.profile ?? 'smime';
  // คำนวณ (และปฏิเสธ) ก่อนสร้าง key เพื่อไม่เสียเวลาสร้าง RSA key เปล่า ๆ
  const period =
    input.profile === 'document_signing'
      ? documentSigningWindow(ca.notAfter, now, config.certValidityDays, input)
      : validityDays(ca.notAfter, now, config.certValidityDays, input.validityDays);
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
    if (typeof period === 'number') {
      // ใบประจำตัว: ใช้ x509 -req แทน openssl ca: ฐานข้อมูลของระบบเป็นแหล่งข้อมูลหลักแทน index.txt
      await runOpenssl(
        config.opensslBin,
        [
          'x509', '-req', '-in', csrFile,
          '-CA', ca.certPath, '-CAkey', ca.keyPath, '-passin', 'env:CA_KEY_PASS',
          '-set_serial', `0x${serial}`, '-days', String(period), '-sha256',
          '-extfile', extFile, '-extensions', EXTENSION_SECTION[profile], '-out', certFile,
        ],
        { secrets: { CA_KEY_PASS: config.ca.keyPassphrase } },
      );
    } else {
      await signWithCa(dir, ca, {
        csrFile, extFile, section: EXTENSION_SECTION[profile], serial, ...period, outFile: certFile,
      });
    }
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
export type EscrowedCertificate = { serialNumber: string; certificatePem: string; escrow: SealedKey };

/**
 * ถอด key สำรองของใบรับรองแล้วส่งให้ use() — ตรวจก่อนเสมอ: ใบออกโดย CA นี้, serial ตรงกับที่ผูกไว้กับก้อนสำรอง
 * และ key คู่กับใบรับรอง (API ส่งข้อมูลผิดใบมาก็จะไม่ได้ผลลัพธ์ที่ใช้ key ของคนอื่นกับใบนี้)
 * ล้างไบต์ของ key ทิ้งเมื่อ use() จบ (สำเร็จหรือไม่ก็ตาม)
 */
async function withEscrowedKey<T>(
  input: EscrowedCertificate,
  use: (key: { cert: X509Certificate; privateKey: KeyObject; ca: CaInfo }) => Promise<T>,
): Promise<T> {
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
    return await use({ cert, privateKey, ca });
  } finally {
    pkcs8Der.fill(0);
  }
}

/** กู้ key จากที่สำรองไว้ แล้วสร้าง .p12 ใหม่ด้วยรหัสผ่านใหม่ของผู้ใช้ (ใบรับรองเดิม ไม่ออกใบใหม่) */
export async function rebuildP12(input: EscrowedCertificate & { p12Password: string; legacyP12: boolean }): Promise<Buffer> {
  return withEscrowedKey(input, ({ privateKey }) =>
    buildP12({ privateKey, certificatePem: input.certificatePem, password: input.p12Password, legacy: input.legacyP12 }),
  );
}

/**
 * ลงนามข้อมูลด้วย key สำรองของผู้ใช้ — คืน CMS SignedData แบบ detached (DER) สำหรับฝังในลายมือชื่อ PDF
 * signer ไม่ตีความ PDF: API ส่งมาเฉพาะไบต์ตาม /ByteRange (ข้อมูลที่ต้องลงนาม) ส่วนการตรวจสิทธิ์ PIN และสถานะใบอยู่ที่ API
 * - CAdES (-cades): มี signingCertificateV2 ผูกใบรับรองของผู้ลงนามไว้ในลายมือชื่อ — ใช้เมื่อ OpenSSL รองรับ (3.2 ขึ้นไป)
 *   รุ่นเก่ายังได้ลายมือชื่อ adbe.pkcs7.detached ที่ Acrobat ยอมรับ (ไม่มี signingCertificateV2)
 * - แนบใบของ CA ทั้งสาย ให้โปรแกรมตรวจต่อสายถึง root ได้โดยไม่ต้องหาใบเอง
 * - ใบหมดอายุหรือยังไม่ถึงวันเริ่ม = ไม่ลงนาม (API ตรวจก่อนแล้ว ตรงนี้กันข้อมูลผิดพลาด)
 */
export async function signCms(input: EscrowedCertificate & { content: Buffer }): Promise<Buffer> {
  return withEscrowedKey(input, async ({ cert, privateKey, ca }) => {
    const now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) {
      throw new AppError(422, 'CERTIFICATE_NOT_VALID_NOW', 'ใบรับรองหมดอายุหรือยังไม่ถึงวันเริ่มใช้');
    }
    const cades = await supportsCmsCades(config.opensslBin);
    return withTempDir(async (dir) => {
      const file = (name: string) => path.join(dir, name);
      const keyPass = await writeEncryptedKey(file('key.pem'), privateKey);
      await Promise.all([
        writeFile(file('cert.pem'), input.certificatePem),
        writeFile(file('chain.pem'), ca.bundlePem),
        writeFile(file('content.bin'), input.content),
      ]);
      await runOpenssl(
        config.opensslBin,
        [
          'cms', '-sign', '-binary', '-in', file('content.bin'),
          '-signer', file('cert.pem'), '-inkey', file('key.pem'), '-passin', 'env:KEY_PASS',
          '-certfile', file('chain.pem'), '-md', 'sha256', ...(cades ? ['-cades'] : []), '-nosmimecap',
          '-outform', 'DER', '-out', file('signature.der'),
        ],
        { secrets: { KEY_PASS: keyPass } },
      );
      return readFile(file('signature.der'));
    });
  });
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
