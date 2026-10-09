import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SignerError, signer, type IssuedCertificate } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ใบรับรองแบบบริการตนเอง: ดูรายการของตัวเอง และขอใบใหม่ (ต้องมี certificate:request)
// mock เฉพาะบริการเซ็น (signer มี test ของตัวเองกับ OpenSSL จริง) ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const PASSWORD = 'my-p12-password';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

/** ผลจาก signer แบบสุ่ม serial/fingerprint ไม่ซ้ำกัน */
function fakeIssued(): IssuedCertificate {
  const now = Date.now();
  return {
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    serialNumber: `1${randomBytes(15).toString('hex')}`,
    fingerprintSha256: randomBytes(32).toString('hex'),
    notBefore: new Date(now),
    notAfter: new Date(now + 365 * DAY),
    p12: Buffer.from('fake-p12-content'),
    escrow: { kekId: 'test-1', encryptedKey: randomBytes(64), wrappedDataKey: randomBytes(60) },
  };
}

function mockSigner() {
  return vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => fakeIssued());
}

/** ผู้ใช้ที่ได้รับ certificate:request ผ่าน role ทดสอบ */
async function requester(input: Parameters<typeof createUser>[0] = {}) {
  await createTestRole('test_cert', ['certificate:request']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_cert'], ...input });
  return { ...user, cookie: await loginAs(user.id) };
}

const postRequest = (cookie: string, body: object = { p12Password: PASSWORD }) =>
  request(app).post('/me/certificates').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

/** เพิ่มใบรับรองตรงในฐานข้อมูล (เตรียมสถานะ) */
async function insertCertificate(
  userId: string,
  input: { notAfter?: Date; revoked?: boolean; createdAt?: Date } = {},
): Promise<string> {
  const issued = fakeIssued();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               revoked_at, revocation_reason, source, certificate_pem, fingerprint_sha256, created_at)
     VALUES ($1, $2, 'ทดสอบ', 'test@msu.ac.th', $3, $4, $5, $6, 'issued', $7, $8, $9)
     RETURNING id`,
    [
      userId,
      issued.serialNumber,
      new Date((input.notAfter?.getTime() ?? Date.now() + DAY) - 365 * DAY),
      input.notAfter ?? issued.notAfter,
      input.revoked ? new Date() : null,
      input.revoked ? 'superseded' : null,
      issued.certificatePem,
      issued.fingerprintSha256,
      input.createdAt ?? new Date(),
    ],
  );
  return rows[0]!.id;
}

describe('GET /me/certificates (ต้อง login เท่านั้น)', () => {
  it('ยังไม่ login → 401', async () => {
    const res = await request(app).get('/me/certificates');
    expect(res.status).toBe(401);
  });

  it('บัญชีรออนุมัติ → 403', async () => {
    const user = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    const res = await request(app).get('/me/certificates').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_PENDING');
  });

  it('ไม่มี permission ก็ดูใบของตัวเองได้ (เช่น ใบที่นำเข้าจากระบบเดิม) และไม่เห็นใบของคนอื่น', async () => {
    const me = await createUser();
    const other = await createUser();
    const mine = await insertCertificate(me.id);
    await insertCertificate(other.id);

    const res = await request(app).get('/me/certificates').set('Cookie', await loginAs(me.id));
    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(2);
    expect(res.body.certificates.map((c: { id: string }) => c.id)).toEqual([mine]);
  });

  it('สถานะ: ใช้งานได้ / หมดอายุ / เพิกถอน (เพิกถอนมาก่อนหมดอายุ) เรียงล่าสุดก่อน', async () => {
    const me = await createUser();
    const now = Date.now();
    const active = await insertCertificate(me.id, { createdAt: new Date(now - 3 * DAY) });
    const expired = await insertCertificate(me.id, { notAfter: new Date(now - DAY), createdAt: new Date(now - 2 * DAY) });
    const revokedAndExpired = await insertCertificate(me.id, {
      notAfter: new Date(now - DAY),
      revoked: true,
      createdAt: new Date(now - DAY),
    });

    const res = await request(app).get('/me/certificates').set('Cookie', await loginAs(me.id));
    expect(res.body.certificates.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([
      [revokedAndExpired, 'revoked'],
      [expired, 'expired'],
      [active, 'active'],
    ]);
    // ไม่ส่ง PEM / key สำรองในรายการ
    expect(res.body.certificates[0]).not.toHaveProperty('certificatePem');
    expect(res.body.certificates[0]).not.toHaveProperty('encryptedKey');
  });
});

describe('POST /me/certificates (certificate:request)', () => {
  it('ไม่มี permission → 403 และไม่เรียก signer', async () => {
    const issue = mockSigner();
    const user = await createUser();
    const res = await postRequest(await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(issue).not.toHaveBeenCalled();
  });

  it('super_admin ขอได้ (ผ่านทุก permission)', async () => {
    mockSigner();
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const res = await postRequest(await loginAs(admin.id));
    expect(res.status).toBe(201);
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    mockSigner();
    const user = await requester();
    const res = await request(app).post('/me/certificates').set('Cookie', user.cookie).send({ p12Password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('ออกใบสำเร็จ: subject มาจากฐานข้อมูล, คืน .p12 ครั้งเดียว และบันทึกใบ + key สำรอง + audit log', async () => {
    const issue = mockSigner();
    const user = await requester({ name: 'สมหญิง รักเรียน', email: 'somying.r@msu.ac.th' });

    const res = await postRequest(user.cookie, { p12Password: PASSWORD, legacyP12: true });

    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(issue).toHaveBeenCalledWith({
      commonName: 'สมหญิง รักเรียน',
      email: 'somying.r@msu.ac.th',
      p12Password: PASSWORD,
      legacyP12: true,
    });
    expect(Buffer.from(res.body.p12, 'base64').toString()).toBe('fake-p12-content');
    expect(res.body.fileName).toBe('somying.r@msu.ac.th.p12');
    expect(res.body.certificate).toMatchObject({ status: 'active', source: 'issued', subjectCn: 'สมหญิง รักเรียน' });

    const { rows } = await pool.query(
      `SELECT c.user_id, c.subject_cn, c.email, c.source, e.kek_id,
              length(e.encrypted_key) AS key_length, a.action, a.actor_id
       FROM certificates c
       JOIN certificate_key_escrows e ON e.certificate_id = c.id
       JOIN certificate_audit_logs a ON a.certificate_id = c.id
       WHERE c.id = $1`,
      [res.body.certificate.id],
    );
    expect(rows).toEqual([
      {
        user_id: user.id,
        subject_cn: 'สมหญิง รักเรียน',
        email: 'somying.r@msu.ac.th',
        source: 'issued',
        kek_id: 'test-1',
        key_length: 64,
        action: 'issue',
        actor_id: user.id,
      },
    ]);
  });

  it('ไม่รับ subject จาก client (ส่งชื่อ/อีเมลมาก็ไม่ใช้)', async () => {
    const issue = mockSigner();
    const user = await requester({ name: 'ชื่อจริง', email: 'real@msu.ac.th' });
    await postRequest(user.cookie, { p12Password: PASSWORD, commonName: 'ปลอม', email: 'fake@evil.test' });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ commonName: 'ชื่อจริง', email: 'real@msu.ac.th' }));
  });

  it('รหัสผ่านสั้นกว่า 8 ตัว → 400 และไม่เรียก signer', async () => {
    const issue = mockSigner();
    const user = await requester();
    const res = await postRequest(user.cookie, { p12Password: 'short' });
    expect(res.status).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it('ชื่อแสดงยาวเกิน 64 ตัวอักษร → 422 (X.509 รองรับไม่เกิน 64)', async () => {
    const issue = mockSigner();
    const user = await requester({ name: 'ก'.repeat(65) });
    const res = await postRequest(user.cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CERTIFICATE_NAME_TOO_LONG');
    expect(issue).not.toHaveBeenCalled();
  });

  it('มีใบที่ใช้งานอยู่ครบ 2 ใบ → 409 แต่ใบที่หมดอายุ/เพิกถอนไม่นับ', async () => {
    const issue = mockSigner();
    const user = await requester();
    await insertCertificate(user.id, { notAfter: new Date(Date.now() - DAY) });
    await insertCertificate(user.id, { revoked: true });
    await insertCertificate(user.id);

    expect((await postRequest(user.cookie)).status).toBe(201);
    const res = await postRequest(user.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CERTIFICATE_LIMIT_REACHED');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('ขอพร้อมกันหลายคำขอ → ได้ไม่เกิน 2 ใบ (ล็อกแถวผู้ใช้)', async () => {
    // signer ช้าเล็กน้อย ให้คำขอซ้อนกันจริง
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeIssued();
    });
    const user = await requester();

    const results = await Promise.all([1, 2, 3, 4].map(() => postRequest(user.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409, 409]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM certificates WHERE user_id = $1', [user.id]);
    expect(rows[0].n).toBe(2);
  });

  it('signer ล่ม → 503 และไม่บันทึกอะไร', async () => {
    vi.spyOn(signer, 'issueCertificate').mockRejectedValue(new SignerError('เรียกบริการเซ็นไม่สำเร็จ'));
    const user = await requester();
    const res = await postRequest(user.cookie);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SIGNER_UNAVAILABLE');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM certificates');
    expect(rows[0].n).toBe(0);
  });

  it('สิทธิ์จากหลาย role รวมกัน: role ที่มี permission อื่นไม่ทำให้ขอได้ แต่เพิ่ม role ที่มีแล้วขอได้', async () => {
    mockSigner();
    await createTestRole('test_reader', ['certificate:read']);
    const user = await createUser({ roles: ['user', 'test_reader'] });
    const cookie = await loginAs(user.id);
    expect((await postRequest(cookie)).status).toBe(403);

    await createTestRole('test_cert', ['certificate:request']);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'test_cert'`, [
      user.id,
    ]);
    expect((await postRequest(cookie)).status).toBe(201);
  });
});
