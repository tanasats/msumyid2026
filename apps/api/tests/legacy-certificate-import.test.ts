import { execFileSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import {
  importLegacyCertificates,
  parseAsn1Time,
  parseIndex,
  parsePasswordCsv,
} from '../src/services/legacy-certificate-import-service.js';
import { SignerRejectedError, signer } from '../src/services/signer-client.js';
import { createUser, resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// นำเข้าใบรับรองเดิมจากโฟลเดอร์ openssl ca — โฟลเดอร์ทดสอบสร้างด้วย OpenSSL จริงให้หน้าตาเหมือนระบบเดิม
// mock เฉพาะบริการเซ็น (signer ทดสอบการถอด key เดิมกับ OpenSSL จริงแล้ว) ฐานข้อมูลใช้ app_test จริง

const app = createApp();

describe('อ่านไฟล์ของระบบเดิม', () => {
  it('parseAsn1Time: UTCTime (ปี 50-99 = 19xx) และ GeneralizedTime', () => {
    expect(parseAsn1Time('261008123456Z').toISOString()).toBe('2026-10-08T12:34:56.000Z');
    expect(parseAsn1Time('991231000000Z').getUTCFullYear()).toBe(1999);
    expect(parseAsn1Time('20510101000000Z').toISOString()).toBe('2051-01-01T00:00:00.000Z');
    expect(() => parseAsn1Time('2026-10-08')).toThrow();
  });

  it('parseIndex: สถานะ วันเพิกถอน เหตุผล และ serial (ตัวพิมพ์เล็ก ไม่มี 0 นำหน้า)', () => {
    const { entries, errors } = parseIndex(
      [
        'V\t271008000000Z\t\t0A1B2C\tunknown\t/C=TH/CN=a',
        'R\t271008000000Z\t261001000000Z,keyCompromise\t1000\tunknown\t/C=TH/CN=b',
        'R\t271008000000Z\t261002000000Z\t1001\tunknown\t/C=TH/CN=c',
        'R\t271008000000Z\t261003000000Z,keyTime,261001000000Z\t1002\tunknown\t/C=TH/CN=d',
        'E\t251008000000Z\t\t1003\tunknown\t/C=TH/CN=e',
        '',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.status, e.serialNumber, e.reason])).toEqual([
      ['V', 'a1b2c', null],
      ['R', '1000', 'keyCompromise'],
      ['R', '1001', 'unspecified'],
      ['R', '1002', 'keyCompromise'],
      ['E', '1003', null],
    ]);
    expect(entries[1]!.revokedAt!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('parseIndex: เหตุผลที่รองรับไม่ได้/สถานะไม่รู้จัก → error พร้อมเลขบรรทัด', () => {
    const { errors } = parseIndex(
      ['R\t271008000000Z\t261001000000Z,certificateHold\tA1\tunknown\t/CN=a', 'X\t271008000000Z\t\tA2\tunknown\t/CN=b'].join('\n'),
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('บรรทัด 1');
    expect(errors[1]).toContain('บรรทัด 2');
  });

  it('parsePasswordCsv: อีเมลไม่สนตัวพิมพ์ รหัสผ่านล่าสุดก่อน', () => {
    const passwords = parsePasswordCsv('A@msu.ac.th,/pkcs12/a.p12,old\r\nb@x.com,/pkcs12/b.p12,bb\na@msu.ac.th,/pkcs12/a.p12,new\n');
    expect(passwords.get('a@msu.ac.th')).toEqual(['new', 'old']);
    expect(passwords.get('b@x.com')).toEqual(['bb']);
  });
});

// ---------- โฟลเดอร์ CA จำลอง ----------

let caDir: string;
const serials = { current: '5A01', old: '5A02', gmail: '5A03' };

function openssl(args: string[], env: Record<string, string> = {}) {
  execFileSync('openssl', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** ออกใบด้วย CA จำลอง: subject จากไฟล์ config (รองรับชื่อไทย) — key เข้ารหัสแบบ genrsa -aes256 ของสคริปต์เดิม */
function issueLegacy(serial: string, cn: string, email: string, outFile: string, keyFile?: string, keyPass?: string) {
  const name = randomBytes(6).toString('hex');
  const key = keyFile ?? path.join(caDir, `${name}.key.pem`);
  const pass = keyPass ?? 'throwaway';
  openssl(['genrsa', '-aes256', '-traditional', '-passout', 'env:P', '-out', key, '2048'], { P: pass });
  const cnf = path.join(caDir, `${name}.cnf`);
  writeFileSync(
    cnf,
    `[ req ]\nprompt = no\ndistinguished_name = dn\nstring_mask = utf8only\nutf8 = yes\n[ dn ]\nC = TH\nO = Mahasarakham University\nCN = ${cn}\nemailAddress = ${email}\n`,
  );
  const csr = path.join(caDir, `${name}.csr`);
  openssl(['req', '-new', '-config', cnf, '-key', key, '-passin', 'env:P', '-out', csr], { P: pass });
  openssl([
    'x509', '-req', '-in', csr, '-CA', path.join(caDir, 'certs', 'univ-ca.cert.pem'), '-CAkey', path.join(caDir, 'ca.key'),
    '-set_serial', `0x${serial}`, '-days', '365', '-out', outFile,
  ]);
}

function writeIndex(lines: string[]) {
  writeFileSync(path.join(caDir, 'index.txt'), `${lines.join('\n')}\n`);
}

const INDEX = {
  current: `V\t271008000000Z\t\t${serials.current}\tunknown\t/C=TH/O=Mahasarakham University/CN=x/emailAddress=staff.a@msu.ac.th`,
  old: `R\t271008000000Z\t260901000000Z,superseded\t${serials.old}\tunknown\t/C=TH/O=Mahasarakham University/CN=x`,
  gmail: `R\t271008000000Z\t260915103000Z\t${serials.gmail}\tunknown\t/C=TH/O=Mahasarakham University/CN=y`,
};

beforeAll(() => {
  caDir = mkdtempSync(path.join(tmpdir(), 'msumyid-legacy-ca-'));
  for (const sub of ['certs', 'newcerts', 'private']) mkdirSync(path.join(caDir, sub));
  // CA จำลอง (ใบของ CA อยู่ใน certs/ เหมือนระบบเดิม — ต้องถูกข้าม)
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', path.join(caDir, 'ca.key'),
    '-out', path.join(caDir, 'certs', 'univ-ca.cert.pem'), '-days', '30',
    '-subj', '/C=TH/O=Mahasarakham University/CN=Legacy Test CA',
  ]);
  // ใบล่าสุดของ staff.a: key อยู่ใน private/ (ทับของใบเก่าเหมือนสคริปต์เดิม) รหัสผ่านคือบรรทัดล่าสุดใน CSV
  issueLegacy(
    serials.current,
    'สมชาย ใจดี',
    'staff.a@msu.ac.th',
    path.join(caDir, 'newcerts', `${serials.current}.pem`),
    path.join(caDir, 'private', 'staff.a@msu.ac.th.key.pem'),
    'pwgen-new',
  );
  // ใบเก่าของคนเดียวกัน (มีแค่ใน certs/) และใบของบัญชี Gmail ที่ยังไม่มีในระบบ
  issueLegacy(serials.old, 'สมชาย ใจดี', 'staff.a@msu.ac.th', path.join(caDir, 'certs', 'staff.a@msu.ac.th.cert.pem'));
  issueLegacy(serials.gmail, 'Guest Lecturer', 'guest.lecturer@gmail.com', path.join(caDir, 'newcerts', `${serials.gmail}.pem`));
  writeFileSync(
    path.join(caDir, 'pkcs12-files.csv'),
    'staff.a@msu.ac.th,/pkcs12/staff.a@msu.ac.th.p12,pwgen-old\nstaff.a@msu.ac.th,/pkcs12/staff.a@msu.ac.th.p12,pwgen-new\n',
  );
});

afterAll(async () => {
  rmSync(caDir, { recursive: true, force: true });
  await resetDatabase();
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  writeIndex([INDEX.current, INDEX.old, INDEX.gmail]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** signer จำลอง: key คู่กับใบล่าสุด (serial ของ current) — คืนก้อนสำรองปลอม */
function mockSigner() {
  const escrowKey = vi.spyOn(signer, 'escrowLegacyKey').mockResolvedValue({
    serialNumber: serials.current.toLowerCase(),
    escrow: { kekId: 'test-1', encryptedKey: randomBytes(48), wrappedDataKey: randomBytes(60) },
  });
  const generateCrl = vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
  return { escrowKey, generateCrl };
}

async function importedRows() {
  const { rows } = await pool.query(
    `SELECT c.serial_number, c.user_id, c.subject_cn, c.email, c.source, c.revocation_reason,
            to_char(c.revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS revoked_at,
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS escrowed,
            (SELECT array_agg(a.action ORDER BY a.created_at) FROM certificate_audit_logs a WHERE a.certificate_id = c.id) AS actions
     FROM certificates c ORDER BY c.serial_number`,
  );
  return rows;
}

describe('importLegacyCertificates', () => {
  it('นำเข้าครบ: ใบ + สถานะเพิกถอนเดิม + เจ้าของตามอีเมล + key สำรองของใบล่าสุด แล้วออก CRL', async () => {
    const { escrowKey, generateCrl } = mockSigner();
    const staff = await createUser({ email: 'Staff.A@msu.ac.th' });

    const report = await importLegacyCertificates({ dir: caDir, dryRun: false });

    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({
      indexEntries: 3,
      newCertificates: 3,
      newRevoked: 2,
      ownedByExistingUsers: 2,
      unowned: 1,
      keyFiles: 1,
      keysEscrowed: 1,
      crlIssued: true,
    });
    expect(await importedRows()).toEqual([
      {
        serial_number: '5a01', user_id: staff.id, subject_cn: 'สมชาย ใจดี', email: 'staff.a@msu.ac.th',
        source: 'imported', revocation_reason: null, revoked_at: null, escrowed: true, actions: ['import'],
      },
      {
        serial_number: '5a02', user_id: staff.id, subject_cn: 'สมชาย ใจดี', email: 'staff.a@msu.ac.th',
        source: 'imported', revocation_reason: 'superseded', revoked_at: '2026-09-01T00:00:00', escrowed: false, actions: ['import'],
      },
      {
        serial_number: '5a03', user_id: null, subject_cn: 'Guest Lecturer', email: 'guest.lecturer@gmail.com',
        source: 'imported', revocation_reason: 'unspecified', revoked_at: '2026-09-15T10:30:00', escrowed: false, actions: ['import'],
      },
    ]);

    // key: รหัสผ่านล่าสุดก่อน และส่งใบของอีเมลนั้นให้ signer จับคู่
    const keyInput = escrowKey.mock.calls[0]![0];
    expect(keyInput.passphrases).toEqual(['pwgen-new', 'pwgen-old']);
    expect(keyInput.privateKeyPem).toContain('ENCRYPTED');
    expect(keyInput.certificates.map((c) => c.serialNumber).sort()).toEqual(['5a01', '5a02']);
    // CRL ใหม่มีใบที่เพิกถอนในระบบเดิมครบ
    expect(generateCrl.mock.calls[0]![0].revoked.map((r) => r.serialNumber).sort()).toEqual(['5a02', '5a03']);
  });

  it('PEM ที่เก็บเป็นใบเดียวกับไฟล์เดิม (fingerprint ตรงกัน)', async () => {
    mockSigner();
    await importLegacyCertificates({ dir: caDir, dryRun: false });
    const { rows } = await pool.query(`SELECT certificate_pem, fingerprint_sha256 FROM certificates WHERE serial_number = '5a01'`);
    const original = new X509Certificate(readFileSync(path.join(caDir, 'newcerts', `${serials.current}.pem`)));
    expect(rows[0].fingerprint_sha256).toBe(original.fingerprint256.replaceAll(':', '').toLowerCase());
    expect(new X509Certificate(rows[0].certificate_pem).fingerprint256).toBe(original.fingerprint256);
  });

  it('--dry-run: ตรวจและรายงานโดยไม่บันทึกและไม่ออก CRL', async () => {
    const { generateCrl } = mockSigner();
    const report = await importLegacyCertificates({ dir: caDir, dryRun: true });
    expect(report).toMatchObject({ newCertificates: 3, keysEscrowed: 1, crlIssued: false, errors: [] });
    expect(await importedRows()).toEqual([]);
    expect(generateCrl).not.toHaveBeenCalled();
  });

  it('รันซ้ำ: ข้ามใบเดิม แต่รับการเพิกถอนที่เพิ่มขึ้นในระบบเดิม (คงวันเพิกถอนเดิม)', async () => {
    const { escrowKey } = mockSigner();
    await importLegacyCertificates({ dir: caDir, dryRun: false });
    writeIndex([
      `R\t271008000000Z\t261005080000Z,keyCompromise\t${serials.current}\tunknown\t/CN=x`,
      INDEX.old,
      INDEX.gmail,
    ]);

    const report = await importLegacyCertificates({ dir: caDir, dryRun: false });

    expect(report).toMatchObject({ newCertificates: 0, alreadyImported: 3, newlyRevokedExisting: 1, keysEscrowed: 0 });
    // key จับคู่ได้กับใบที่มี key สำรองแล้ว → ข้าม ไม่บันทึกซ้ำ
    expect(escrowKey).toHaveBeenCalledTimes(2);
    const current = (await importedRows()).find((r) => r.serial_number === '5a01');
    expect(current).toMatchObject({ revocation_reason: 'keyCompromise', revoked_at: '2026-10-05T08:00:00', actions: ['import', 'revoke'] });
  });

  it('ไม่พบไฟล์ของใบใน index → error และไม่บันทึกอะไรเลย (ใบที่เพิกถอนต้องครบ)', async () => {
    mockSigner();
    writeIndex([INDEX.current, `R\t271008000000Z\t260901000000Z\tFFFF\tunknown\t/CN=missing`]);
    const report = await importLegacyCertificates({ dir: caDir, dryRun: false });
    expect(report.errors).toEqual([expect.stringContaining('ไม่พบไฟล์ใบรับรอง serial ffff')]);
    expect(await importedRows()).toEqual([]);
  });

  it('key ถอดไม่ได้/ไม่คู่ → คำเตือน แต่ยังนำเข้าใบได้', async () => {
    vi.spyOn(signer, 'escrowLegacyKey').mockRejectedValue(new SignerRejectedError(422, 'KEY_DECRYPT_FAILED'));
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const report = await importLegacyCertificates({ dir: caDir, dryRun: false });
    expect(report.errors).toEqual([]);
    expect(report.keysEscrowed).toBe(0);
    expect(report.warnings).toEqual([expect.stringContaining('รหัสผ่านไม่ถูกต้อง')]);
    expect((await importedRows()).length).toBe(3);
  });
});

describe('ผูกใบที่ยังไม่มีเจ้าของตอน login', () => {
  async function insertUnowned(email: string) {
    await pool.query(
      `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                                 source, certificate_pem, fingerprint_sha256)
       VALUES (NULL, $1, 'ทดสอบ', $2, now(), now() + interval '1 year', 'imported', '-----BEGIN CERTIFICATE-----', $3)`,
      [`1${randomBytes(8).toString('hex')}`, email, randomBytes(32).toString('hex')],
    );
  }

  async function ownerOf(email: string) {
    const { rows } = await pool.query(`SELECT user_id FROM certificates WHERE email = $1`, [email]);
    return rows[0].user_id as string | null;
  }

  it('login ด้วย Gmail ที่ตรงกับอีเมลในใบ → ผูกเป็นเจ้าของ (ไม่สนตัวพิมพ์)', async () => {
    await insertUnowned('Guest.Lecturer@gmail.com');
    const { res } = await google.loginWith(app, { email: 'guest.lecturer@gmail.com', hd: null });
    expect(res.status).toBe(302);
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = 'guest.lecturer@gmail.com'`);
    expect(await ownerOf('Guest.Lecturer@gmail.com')).toBe(rows[0].id);
  });

  it('อีเมล มมส. ที่ไม่มี hd (บัญชี Google ส่วนตัว) → ไม่ผูก', async () => {
    await insertUnowned('somchai.s@msu.ac.th');
    await google.loginWith(app, { email: 'somchai.s@msu.ac.th', hd: null });
    expect(await ownerOf('somchai.s@msu.ac.th')).toBeNull();
  });
});
