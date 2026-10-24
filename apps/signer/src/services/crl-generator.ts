import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '../config/index.js';
import { loadCa } from './ca.js';
import { asn1Time, confPath, evenHex, runOpenssl } from './openssl.js';

// ออก CRL ด้วย openssl ca -gencrl เหมือนระบบเดิม แต่สร้าง index.txt ชั่วคราวจากรายการที่ API ส่งมา
// (ฐานข้อมูลของระบบเป็นแหล่งข้อมูลหลัก ไม่มี index.txt ถาวร) แล้วลบทิ้งทุกครั้ง

/** ชื่อเหตุผลตาม openssl ca -crl_reason (ตรงกับ certificates.revocation_reason) */
export type RevocationReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'CACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation';

export type RevokedEntry = {
  serialNumber: string;
  revokedAt: Date;
  reason: RevocationReason;
  notAfter: Date;
};

export type GenerateCrlInput = {
  /** เลข CRL (เพิ่มขึ้นเสมอ — API เป็นผู้กำหนด) */
  crlNumber: bigint;
  thisUpdate: Date;
  nextUpdate: Date;
  revoked: RevokedEntry[];
};

/**
 * แถวของ index.txt: สถานะ R, วันหมดอายุ, วันเพิกถอน,เหตุผล, serial, ชื่อไฟล์ (unknown), subject
 * subject ไม่ถูกใส่ใน CRL จึงใช้ค่าสมมติที่ไม่ซ้ำกัน (/CN=<serial>) ไม่ต้องส่งชื่อ/อีเมลผู้ใช้มาที่นี่
 */
function indexLine(entry: RevokedEntry): string {
  const serial = evenHex(entry.serialNumber);
  const expiry = asn1Time(entry.notAfter, entry.notAfter.getUTCFullYear() >= 2050 ? 'generalized' : 'utc');
  return ['R', expiry, `${asn1Time(entry.revokedAt)},${entry.reason}`, serial, 'unknown', `/CN=${serial}`].join('\t');
}

/** สร้างและเซ็น CRL — คืนแบบ DER */
export async function generateCrl(input: GenerateCrlInput): Promise<Buffer> {
  const ca = await loadCa();
  const dir = await mkdtemp(path.join(tmpdir(), 'msumyid-crl-'));
  try {
    const file = (name: string) => path.join(dir, name);
    await writeFile(file('index.txt'), input.revoked.map((e) => `${indexLine(e)}\n`).join(''));
    await writeFile(file('crlnumber'), `${evenHex(input.crlNumber.toString(16))}\n`);
    await writeFile(
      file('ca.cnf'),
      [
        '[ ca ]',
        'default_ca = CA_default',
        '',
        '[ CA_default ]',
        `database = ${confPath(file('index.txt'))}`,
        `crlnumber = ${confPath(file('crlnumber'))}`,
        `certificate = ${confPath(ca.certPath)}`,
        `private_key = ${confPath(ca.keyPath)}`,
        'default_md = sha256',
        'unique_subject = no',
        'crl_extensions = crl_ext',
        '',
        // เหมือน [ crl_ext ] ของ intermediate.cnf เดิม
        '[ crl_ext ]',
        'authorityKeyIdentifier = keyid:always',
        '',
      ].join('\n'),
    );

    await runOpenssl(
      config.opensslBin,
      [
        'ca', '-gencrl', '-batch', '-config', file('ca.cnf'), '-passin', 'env:CA_KEY_PASS',
        '-crl_lastupdate', asn1Time(input.thisUpdate, 'generalized'),
        '-crl_nextupdate', asn1Time(input.nextUpdate, 'generalized'),
        '-out', file('crl.pem'),
      ],
      { secrets: { CA_KEY_PASS: config.ca.keyPassphrase } },
    );
    await runOpenssl(config.opensslBin, ['crl', '-in', file('crl.pem'), '-outform', 'DER', '-out', file('crl.der')]);
    return await readFile(file('crl.der'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
