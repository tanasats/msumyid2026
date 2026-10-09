import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOpenssl } from '../src/services/openssl.js';

// สร้าง Root + Intermediate CA ปลอมสำหรับ dev/test — subject (C, O) เหมือน CA จริงของมหาวิทยาลัย
// ห้ามนำ CA key จริงมาใช้บนเครื่อง dev (docs/design/certificates.md)
// ใช้: pnpm --filter signer dev-ca [โฟลเดอร์ปลายทาง] (ค่าเริ่มต้น apps/signer/.dev-ca — ไม่ commit)
// รันซ้ำได้: ถ้ามี CA อยู่แล้วจะไม่สร้างทับ แค่แสดงค่า env อีกครั้ง

const SUBJECT_BASE = ['C = TH', 'O = Mahasarakham University'];

export type DevCa = { certPath: string; keyPath: string; passphrase: string; created: boolean };

function reqConfig(commonName: string, extensions: string[]): string {
  return [
    '[ req ]',
    'prompt = no',
    'distinguished_name = dn',
    'string_mask = utf8only',
    'x509_extensions = v3_ca',
    '',
    '[ dn ]',
    ...SUBJECT_BASE,
    `CN = ${commonName}`,
    '',
    '[ v3_ca ]',
    ...extensions,
    '',
  ].join('\n');
}

const ROOT_EXTENSIONS = [
  'subjectKeyIdentifier = hash',
  'authorityKeyIdentifier = keyid:always,issuer',
  'basicConstraints = critical, CA:true',
  'keyUsage = critical, digitalSignature, cRLSign, keyCertSign',
];

// เหมือน v3_intermediate_ca ของคู่มือที่ระบบเดิมใช้ (pathlen:0 = ออกได้เฉพาะใบของผู้ใช้)
const INTERMEDIATE_EXTENSIONS = [
  'subjectKeyIdentifier = hash',
  'authorityKeyIdentifier = keyid:always,issuer',
  'basicConstraints = critical, CA:true, pathlen:0',
  'keyUsage = critical, digitalSignature, cRLSign, keyCertSign',
];

export async function createDevCa(dir: string, options: { passphrase?: string; opensslBin?: string } = {}): Promise<DevCa> {
  const bin = options.opensslBin ?? 'openssl';
  const abs = path.resolve(dir);
  const certPath = path.join(abs, 'intermediate.cert.pem');
  const keyPath = path.join(abs, 'intermediate.key.pem');
  const passphraseFile = path.join(abs, 'passphrase.txt');

  if (existsSync(certPath)) {
    const passphrase = (await readFile(passphraseFile, 'utf8')).trim();
    return { certPath, keyPath, passphrase, created: false };
  }

  await mkdir(abs, { recursive: true });
  const passphrase = options.passphrase ?? randomBytes(24).toString('base64url');
  const file = (name: string) => path.join(abs, name);

  // Root CA: key ไม่เข้ารหัส (ของปลอมสำหรับ dev เท่านั้น)
  await writeFile(file('root.cnf'), reqConfig('MSU Digital ID DEV Root CA', ROOT_EXTENSIONS));
  await runOpenssl(bin, [
    'req', '-x509', '-new', '-newkey', 'rsa:2048', '-noenc', '-config', file('root.cnf'),
    '-keyout', file('root.key.pem'), '-out', file('root.cert.pem'), '-days', '3650', '-sha256',
  ]);

  // Intermediate CA: key เข้ารหัสด้วย passphrase เหมือนของจริง แล้วให้ Root เซ็น
  await writeFile(file('intermediate.cnf'), reqConfig('MSU Digital ID DEV Intermediate CA', INTERMEDIATE_EXTENSIONS));
  await runOpenssl(
    bin,
    [
      'req', '-new', '-newkey', 'rsa:2048', '-config', file('intermediate.cnf'),
      '-keyout', keyPath, '-passout', 'env:CA_PASS', '-out', file('intermediate.csr'),
    ],
    { secrets: { CA_PASS: passphrase } },
  );
  await runOpenssl(bin, [
    'x509', '-req', '-in', file('intermediate.csr'), '-CA', file('root.cert.pem'), '-CAkey', file('root.key.pem'),
    '-set_serial', '0x1000', '-days', '1825', '-sha256',
    '-extfile', file('intermediate.cnf'), '-extensions', 'v3_ca', '-out', certPath,
  ]);
  await writeFile(passphraseFile, passphrase, { mode: 0o600 });

  return { certPath, keyPath, passphrase, created: true };
}

// รันเป็นสคริปต์ (ไม่ใช่ถูก import จาก test)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? '.dev-ca';
  try {
    const ca = await createDevCa(dir);
    console.log(ca.created ? `สร้าง CA สำหรับ dev ที่ ${path.dirname(ca.certPath)}` : 'มี CA สำหรับ dev อยู่แล้ว (ไม่สร้างทับ)');
    console.log('\nใส่ค่าต่อไปนี้ใน apps/signer/.env:\n');
    console.log(`CA_CERT_PATH=${ca.certPath}`);
    console.log(`CA_KEY_PATH=${ca.keyPath}`);
    console.log(`CA_KEY_PASSPHRASE=${ca.passphrase}`);
    if (ca.created) console.log(`ESCROW_KEK=${randomBytes(32).toString('base64')}`);
  } catch (err) {
    console.error('สร้าง CA สำหรับ dev ไม่สำเร็จ:', err);
    process.exit(1);
  }
}
