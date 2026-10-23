import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SignerError, SignerRejectedError, signer, type IssuedCertificate } from '../src/services/signer-client.js';
import { bangkokToday, rangeDays, rangeToValidity } from '../src/services/supplementary-certificate-service.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ใบรับรองเสริม: คำขอ → อนุมัติ → รับใบ (supplementary_certificate:request / certificate:approve)
// mock เฉพาะบริการเซ็น ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const PASSWORD = 'my-p12-password';
const DAY = 24 * 60 * 60 * 1000;

/** วันที่ (YYYY-MM-DD ตามเวลาไทย) ห่างจากวันนี้ n วัน */
const day = (n: number) => new Date(Date.parse(`${bangkokToday(new Date())}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

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

function fakeIssued(input: { notBefore?: Date; notAfter?: Date } = {}): IssuedCertificate {
  return {
    certificatePem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    serialNumber: `1${randomBytes(15).toString('hex')}`,
    fingerprintSha256: randomBytes(32).toString('hex'),
    notBefore: input.notBefore ?? new Date(),
    notAfter: input.notAfter ?? new Date(Date.now() + 7 * DAY),
    p12: Buffer.from('fake-p12-content'),
    escrow: { kekId: 'test-1', encryptedKey: randomBytes(64), wrappedDataKey: randomBytes(60) },
  };
}

/** signer คืนใบตามช่วงที่ส่งไป (เหมือน signer จริงเมื่อไม่ต้องตัด) */
function mockSigner() {
  return vi.spyOn(signer, 'issueCertificate').mockImplementation(async (input) =>
    fakeIssued('notBefore' in input ? { notBefore: input.notBefore, notAfter: input.notAfter } : {}),
  );
}

async function ensureRole(code: `test_${string}`, permissions: string[]) {
  await createTestRole(code, permissions).catch(() => {});
}

/** ผู้ใช้ที่ขอใบเสริมได้ */
async function requester(input: Parameters<typeof createUser>[0] = {}) {
  await ensureRole('test_supp', ['supplementary_certificate:request']);
  const user = await createUser({ roles: ['user', 'staff', 'test_supp'], ...input });
  return { ...user, cookie: await loginAs(user.id) };
}

/** ผู้อนุมัติ (มี certificate:approve ผ่าน role ทดสอบ ไม่ใช่ super_admin) */
async function approver() {
  await ensureRole('test_approve', ['certificate:approve']);
  const user = await createUser({ roles: ['user', 'staff', 'test_approve'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

const submit = (cookie: string, body: object = {}) =>
  post(cookie, '/me/supplementary-certificate-requests', {
    purpose: 'ลงนามเกียรติบัตรงานประชุมวิชาการ',
    startDate: day(1),
    endDate: day(7),
    ...body,
  });

const approve = (cookie: string, id: string, body: object = {}) =>
  post(cookie, `/admin/supplementary-certificate-requests/${id}/approve`, { startDate: day(1), endDate: day(7), ...body });

const claim = (cookie: string, id: string) =>
  post(cookie, `/me/supplementary-certificate-requests/${id}/certificate`, { p12Password: PASSWORD });

/** ส่งคำขอแล้วอนุมัติ — คืน id ของคำขอ */
async function approvedRequest(user: { cookie: string }, range = { startDate: day(1), endDate: day(7) }) {
  const res = await submit(user.cookie, range);
  expect(res.status).toBe(201);
  const { cookie } = await approver();
  expect((await approve(cookie, res.body.request.id, range)).status).toBe(200);
  return res.body.request.id as string;
}

async function setPolicy(sql: string) {
  await pool.query(`UPDATE certificate_policies SET ${sql}`);
}

describe('วันที่ตามเวลาประเทศไทย', () => {
  it('วันนี้: 23:30 น. UTC = วันถัดไปของไทย', () => {
    expect(bangkokToday(new Date('2026-10-24T16:59:59Z'))).toBe('2026-10-24');
    expect(bangkokToday(new Date('2026-10-24T17:00:00Z'))).toBe('2026-10-25');
  });

  it('ช่วง 1-7 = 7 วัน, ใบเริ่ม 00:00 ถึง 23:59:59 ตามเวลาไทย', () => {
    expect(rangeDays('2026-11-01', '2026-11-07')).toBe(7);
    expect(rangeDays('2026-11-01', '2026-11-01')).toBe(1);
    expect(rangeToValidity('2026-11-01', '2026-11-07')).toEqual({
      notBefore: new Date('2026-10-31T17:00:00Z'),
      notAfter: new Date('2026-11-07T16:59:59Z'),
    });
  });
});

describe('ส่งคำขอ (supplementary_certificate:request)', () => {
  it('ยังไม่ login → 401 / ไม่มี permission → 403 / certificate:request อย่างเดียวไม่พอ', async () => {
    expect((await request(app).get('/me/supplementary-certificate-requests')).status).toBe(401);
    await ensureRole('test_cert', ['certificate:request']);
    const user = await createUser({ roles: ['user', 'staff', 'test_cert'] });
    const res = await submit(await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('สิทธิ์จากหลาย role รวมกัน และ super_admin ส่งได้', async () => {
    await ensureRole('test_cert', ['certificate:request']);
    await ensureRole('test_supp', ['supplementary_certificate:request']);
    const user = await createUser({ roles: ['user', 'staff', 'test_cert', 'test_supp'] });
    expect((await submit(await loginAs(user.id))).status).toBe(201);

    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    expect((await submit(await loginAs(admin.id))).status).toBe(201);
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const user = await requester();
    const res = await request(app)
      .post('/me/supplementary-certificate-requests')
      .set('Cookie', user.cookie)
      .send({ purpose: 'x', startDate: day(1), endDate: day(2) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('สำเร็จ: สถานะรออนุมัติ + log submit พร้อมช่วงที่ขอ และหน้าของฉันเห็นเฉพาะคำขอของตัวเอง', async () => {
    const user = await requester();
    const other = await requester();
    const res = await submit(user.cookie, { purpose: '  ลงนามเกียรติบัตร  ' });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({
      purpose: 'ลงนามเกียรติบัตร',
      requestedStart: day(1),
      requestedEnd: day(7),
      approvedStart: null,
      status: 'pending',
      decidedBy: null,
    });
    await submit(other.cookie);

    const mine = await request(app).get('/me/supplementary-certificate-requests').set('Cookie', user.cookie);
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toEqual([res.body.request.id]);
    expect(mine.body.limits).toEqual({ maxDays: 90, maxLeadDays: 90, maxActive: 3, open: 1, today: day(0) });

    const { rows } = await pool.query(
      `SELECT actor_id, action, to_char(range_start, 'YYYY-MM-DD') AS s, to_char(range_end, 'YYYY-MM-DD') AS e
       FROM supplementary_certificate_request_logs WHERE request_id = $1`,
      [res.body.request.id],
    );
    expect(rows).toEqual([{ actor_id: user.id, action: 'submit', s: day(1), e: day(7) }]);
  });

  it('ช่วงวันที่ผิดนโยบาย → 422 RANGE_INVALID / รูปแบบผิด → 400', async () => {
    const user = await requester();
    for (const range of [
      { startDate: day(-1), endDate: day(3) }, // ย้อนหลัง
      { startDate: day(91), endDate: day(92) }, // ล่วงหน้าเกิน 90 วัน
      { startDate: day(0), endDate: day(90) }, // 91 วัน > 90
    ]) {
      const res = await submit(user.cookie, range);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('RANGE_INVALID');
    }
    expect((await submit(user.cookie, { startDate: day(0), endDate: day(89) })).status).toBe(201);
    expect((await submit(user.cookie, { startDate: day(5), endDate: day(4) })).status).toBe(400);
    expect((await submit(user.cookie, { startDate: '2026-02-30', endDate: day(4) })).status).toBe(400);
    expect((await submit(user.cookie, { purpose: '   ' })).status).toBe(400);
  });

  it('เพดานจำนวน: นับใบเสริมที่ใช้งานอยู่ + คำขอที่ค้าง / เพดาน 0 = ปิดรับคำขอ', async () => {
    await setPolicy('supplementary_max_active = 2');
    const user = await requester();
    expect((await submit(user.cookie)).status).toBe(201);
    expect((await submit(user.cookie)).status).toBe(201);
    const res = await submit(user.cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUPPLEMENTARY_LIMIT_REACHED');

    await setPolicy('supplementary_max_active = 0');
    const other = await requester();
    const closed = await submit(other.cookie);
    expect(closed.status).toBe(409);
    expect(closed.body.error.message).toContain('ยังไม่เปิด');
  });

  it('ส่งพร้อมกันหลายคำขอ → ไม่เกินเพดาน (ล็อกแถวผู้ใช้)', async () => {
    await setPolicy('supplementary_max_active = 1');
    const user = await requester();
    const results = await Promise.all([1, 2, 3].map(() => submit(user.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('ชื่อแสดงยาวเกิน 64 ตัวอักษร → 422 ตั้งแต่ตอนขอ', async () => {
    const user = await requester({ name: 'ก'.repeat(65) });
    const res = await submit(user.cookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CERTIFICATE_NAME_TOO_LONG');
  });
});

describe('ยกเลิกคำขอ', () => {
  it('ยกเลิกคำขอของตัวเองได้ คำขอของคนอื่น → 404 และยกเลิกซ้ำ → 409', async () => {
    const user = await requester();
    const other = await requester();
    const { body } = await submit(user.cookie);
    const path = `/me/supplementary-certificate-requests/${body.request.id}/cancel`;

    expect((await post(other.cookie, path)).status).toBe(404);
    const res = await post(user.cookie, path);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('cancelled');
    expect((await post(user.cookie, path)).status).toBe(409);
  });

  it('อนุมัติแล้วยังไม่รับใบ → ยกเลิกได้ และไม่นับในเพดานอีก', async () => {
    await setPolicy('supplementary_max_active = 1');
    const user = await requester();
    const id = await approvedRequest(user);
    expect((await post(user.cookie, `/me/supplementary-certificate-requests/${id}/cancel`)).status).toBe(200);
    expect((await submit(user.cookie)).status).toBe(201);
  });
});

describe('อนุมัติ / ปฏิเสธ (certificate:approve)', () => {
  it('ไม่มี permission → 403 / role ที่ผูก certificate:approve เข้าได้', async () => {
    const user = await requester();
    const { body } = await submit(user.cookie);
    const other = await requester();
    expect((await approve(other.cookie, body.request.id)).status).toBe(403);
    expect((await request(app).get('/admin/supplementary-certificate-requests').set('Cookie', other.cookie)).status).toBe(
      403,
    );

    const { cookie } = await approver();
    expect((await request(app).get('/admin/supplementary-certificate-requests').set('Cookie', cookie)).status).toBe(200);
  });

  it('คิวรออนุมัติ เก่าก่อน พร้อมข้อมูลผู้ขอ และจำนวนที่รอ', async () => {
    const a = await requester({ name: 'ผู้ขอ ก', email: 'a@msu.ac.th' });
    const b = await requester({ name: 'ผู้ขอ ข' });
    const first = await submit(a.cookie);
    await submit(b.cookie);
    const { cookie } = await approver();

    const res = await request(app).get('/admin/supplementary-certificate-requests').set('Cookie', cookie);
    expect(res.body.pendingCount).toBe(2);
    expect(res.body.limits).toEqual({ maxDays: 90, maxLeadDays: 90, today: day(0) });
    expect(res.body.requests.map((r: { requester: { displayName: string } }) => r.requester.displayName)).toEqual([
      'ผู้ขอ ก',
      'ผู้ขอ ข',
    ]);
    expect(res.body.requests[0]).toMatchObject({
      id: first.body.request.id,
      requester: { id: a.id, email: 'a@msu.ac.th', accountType: 'staff' },
    });
  });

  it('อนุมัติโดยแก้ช่วงวันที่ → ผู้ขอเห็นช่วงที่อนุมัติ ผู้อนุมัติ และ log เก็บช่วงที่อนุมัติ', async () => {
    const user = await requester();
    const { body } = await submit(user.cookie, { startDate: day(1), endDate: day(30) });
    const actor = await approver();

    const res = await approve(actor.cookie, body.request.id, { startDate: day(2), endDate: day(10), note: 'ลดเหลือช่วงงาน' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: 'approved',
      requestedStart: day(1),
      requestedEnd: day(30),
      approvedStart: day(2),
      approvedEnd: day(10),
      decisionNote: 'ลดเหลือช่วงงาน',
      decidedBy: { id: actor.id },
    });

    const { rows } = await pool.query(
      `SELECT actor_id, action, to_char(range_start, 'YYYY-MM-DD') AS s, to_char(range_end, 'YYYY-MM-DD') AS e
       FROM supplementary_certificate_request_logs WHERE request_id = $1 ORDER BY created_at, action DESC`,
      [body.request.id],
    );
    expect(rows).toEqual([
      { actor_id: user.id, action: 'submit', s: day(1), e: day(30) },
      { actor_id: actor.id, action: 'approve', s: day(2), e: day(10) },
    ]);
    // อนุมัติซ้ำ → 409
    expect((await approve(actor.cookie, body.request.id)).status).toBe(409);
  });

  it('ช่วงที่อนุมัติต้องอยู่ในนโยบาย: ยาวเกินเพดาน / สิ้นสุดแล้ว → 422 แต่วันเริ่มผ่านไปแล้วอนุมัติได้', async () => {
    const user = await requester();
    const { body } = await submit(user.cookie);
    const { cookie } = await approver();
    expect((await approve(cookie, body.request.id, { startDate: day(0), endDate: day(90) })).status).toBe(422);
    expect((await approve(cookie, body.request.id, { startDate: day(-5), endDate: day(-1) })).status).toBe(422);
    expect((await approve(cookie, body.request.id, { startDate: day(-2), endDate: day(3) })).status).toBe(200);
  });

  it('กฎ canManageUser: คำขอของตัวเอง → 403 / ผู้ดูแลสิทธิ์สูงต้องเป็น super_admin', async () => {
    await ensureRole('test_both', ['certificate:approve', 'supplementary_certificate:request']);
    const self = await createUser({ roles: ['user', 'staff', 'test_both'] });
    const selfCookie = await loginAs(self.id);
    const own = await submit(selfCookie);
    const res = await approve(selfCookie, own.body.request.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_MANAGE_SELF');

    await ensureRole('test_supp', ['supplementary_certificate:request']);
    const privileged = await createUser({ roles: ['user', 'staff', 'admin', 'test_supp'] });
    const privilegedRequest = await submit(await loginAs(privileged.id));
    const { cookie } = await approver();
    const denied = await approve(cookie, privilegedRequest.body.request.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PRIVILEGED_TARGET');

    const superAdmin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    expect((await approve(await loginAs(superAdmin.id), privilegedRequest.body.request.id)).status).toBe(200);
  });

  it('ปฏิเสธต้องมีเหตุผล → ผู้ขอเห็นเหตุผล และไม่นับในเพดาน', async () => {
    await setPolicy('supplementary_max_active = 1');
    const user = await requester();
    const { body } = await submit(user.cookie);
    const { cookie } = await approver();
    const path = `/admin/supplementary-certificate-requests/${body.request.id}/reject`;

    expect((await post(cookie, path, { note: '  ' })).status).toBe(400);
    const res = await post(cookie, path, { note: 'ใช้ใบประจำตัวแทนได้' });
    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ status: 'rejected', decisionNote: 'ใช้ใบประจำตัวแทนได้' });
    expect((await submit(user.cookie)).status).toBe(201);

    const history = await request(app).get('/admin/supplementary-certificate-requests?view=rejected').set('Cookie', cookie);
    expect(history.body.requests.map((r: { id: string }) => r.id)).toEqual([body.request.id]);
  });
});

describe('รับใบรับรองเสริม', () => {
  it('ยังไม่อนุมัติ → 409 และไม่เรียก signer', async () => {
    const issue = mockSigner();
    const user = await requester();
    const { body } = await submit(user.cookie);
    const res = await claim(user.cookie, body.request.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_NOT_APPROVED');
    expect(issue).not.toHaveBeenCalled();
  });

  it('สำเร็จ: ส่งโปรไฟล์ลงนามเอกสาร + ช่วงที่อนุมัติ, บันทึกใบเสริม + key สำรอง, คำขอเป็น issued', async () => {
    const issue = mockSigner();
    const user = await requester({ name: 'สมหญิง รักเรียน', email: 'somying.r@msu.ac.th' });
    const id = await approvedRequest(user, { startDate: day(2), endDate: day(5) });

    const res = await claim(user.cookie, id);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(issue).toHaveBeenCalledWith({
      commonName: 'สมหญิง รักเรียน',
      email: 'somying.r@msu.ac.th',
      p12Password: PASSWORD,
      legacyP12: false,
      profile: 'document_signing',
      ...rangeToValidity(day(2), day(5)),
    });
    expect(res.body.certificate).toMatchObject({ kind: 'supplementary', status: 'active', hasKeyEscrow: true });
    expect(res.body.fileName).toMatch(/^somying\.r@msu\.ac\.th-[0-9a-f]{8}\.p12$/);

    const { rows } = await pool.query(
      `SELECT r.status, c.kind, c.user_id, e.kek_id, a.action
       FROM supplementary_certificate_requests r
       JOIN certificates c ON c.id = r.certificate_id
       JOIN certificate_key_escrows e ON e.certificate_id = c.id
       JOIN certificate_audit_logs a ON a.certificate_id = c.id
       WHERE r.id = $1`,
      [id],
    );
    expect(rows).toEqual([{ status: 'issued', kind: 'supplementary', user_id: user.id, kek_id: 'test-1', action: 'issue' }]);

    // รับซ้ำ → 409 (ดาวน์โหลดใหม่ได้ที่รายการใบรับรอง)
    const again = await claim(user.cookie, id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('REQUEST_ALREADY_ISSUED');
  });

  it('กดรับพร้อมกัน → ได้ใบเดียว', async () => {
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeIssued();
    });
    const user = await requester();
    const id = await approvedRequest(user);
    const results = await Promise.all([1, 2, 3].map(() => claim(user.cookie, id)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('คำขอของคนอื่น → 404 / ไม่มีสิทธิ์ขอใบเสริม → 403', async () => {
    mockSigner();
    const user = await requester();
    const id = await approvedRequest(user);
    const other = await requester();
    expect((await claim(other.cookie, id)).status).toBe(404);

    await ensureRole('test_cert', ['certificate:request']);
    const noPermission = await createUser({ roles: ['user', 'staff', 'test_cert'] });
    expect((await claim(await loginAs(noPermission.id), id)).status).toBe(403);
  });

  it('เลยวันสิ้นสุดแล้วไม่ได้รับ → สถานะ expired และรับไม่ได้ (409) ไม่นับในเพดาน', async () => {
    const issue = mockSigner();
    await setPolicy('supplementary_max_active = 1');
    const user = await requester();
    const id = await approvedRequest(user);
    await pool.query(
      `UPDATE supplementary_certificate_requests SET approved_start = $2, approved_end = $3 WHERE id = $1`,
      [id, day(-5), day(-1)],
    );

    const list = await request(app).get('/me/supplementary-certificate-requests').set('Cookie', user.cookie);
    expect(list.body.requests[0].status).toBe('expired');
    const res = await claim(user.cookie, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_EXPIRED');
    expect(issue).not.toHaveBeenCalled();
    expect((await submit(user.cookie)).status).toBe(201);

    const { cookie } = await approver();
    const history = await request(app).get('/admin/supplementary-certificate-requests?view=expired').set('Cookie', cookie);
    expect(history.body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('signer ปฏิเสธเพราะช่วงสิ้นสุดแล้ว → 409 REQUEST_EXPIRED / signer ล่ม → 503 คำขอยังรอรับใบ', async () => {
    const user = await requester();
    const id = await approvedRequest(user);

    vi.spyOn(signer, 'issueCertificate').mockRejectedValueOnce(new SignerRejectedError(422, 'VALIDITY_INVALID'));
    expect((await claim(user.cookie, id)).body.error.code).toBe('REQUEST_EXPIRED');

    vi.spyOn(signer, 'issueCertificate').mockRejectedValueOnce(new SignerError('ล่ม'));
    const res = await claim(user.cookie, id);
    expect(res.status).toBe(503);
    const { rows } = await pool.query('SELECT status FROM supplementary_certificate_requests WHERE id = $1', [id]);
    expect(rows[0].status).toBe('approved');
  });

  it('ผู้ดูแลลดเพดานหลังอนุมัติ → รับใบไม่ได้ (409)', async () => {
    mockSigner();
    const user = await requester();
    const first = await approvedRequest(user);
    await approvedRequest(user);
    await setPolicy('supplementary_max_active = 1');
    const res = await claim(user.cookie, first);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SUPPLEMENTARY_LIMIT_REACHED');
  });
});

describe('ใบเสริมที่รับแล้ว: เพิกถอน / ดาวน์โหลดใหม่ ตรวจ permission ตามประเภทใบ', () => {
  async function issuedSupplementary(user: { cookie: string }) {
    mockSigner();
    const id = await approvedRequest(user);
    const res = await claim(user.cookie, id);
    return res.body.certificate.id as string;
  }

  it('มีแค่ certificate:request → จัดการใบเสริมไม่ได้ (403)', async () => {
    const user = await requester();
    const certificateId = await issuedSupplementary(user);
    await pool.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE code = 'test_supp')`,
      [user.id],
    );
    await ensureRole('test_cert', ['certificate:request']);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'test_cert'`, [user.id]);

    const revoke = await post(user.cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'superseded' });
    expect(revoke.status).toBe(403);
    const p12 = await post(user.cookie, `/me/certificates/${certificateId}/p12`, { p12Password: PASSWORD });
    expect(p12.status).toBe(403);
  });

  it('มี supplementary_certificate:request → ดาวน์โหลดใหม่และเพิกถอนใบเสริมได้', async () => {
    const user = await requester();
    const certificateId = await issuedSupplementary(user);
    vi.spyOn(signer, 'rebuildP12').mockResolvedValue(Buffer.from('rebuilt'));
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));

    expect((await post(user.cookie, `/me/certificates/${certificateId}/p12`, { p12Password: PASSWORD })).status).toBe(200);
    expect((await post(user.cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'superseded' })).status).toBe(200);
  });
});

describe('ปิดบัญชี / ลบบัญชี', () => {
  it('ปิดบัญชี → คำขอที่ค้าง (รออนุมัติ + อนุมัติแล้ว) ถูกยกเลิกพร้อม log ส่วนที่ปฏิเสธไปแล้วไม่เปลี่ยน', async () => {
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const user = await requester();
    const pending = (await submit(user.cookie)).body.request.id;
    const approved = await approvedRequest(user);
    const rejected = (await submit(user.cookie)).body.request.id;
    const { cookie: approverCookie } = await approver();
    await post(approverCookie, `/admin/supplementary-certificate-requests/${rejected}/reject`, { note: 'ไม่จำเป็น' });

    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const res = await post(await loginAs(admin.id), `/admin/users/${user.id}/deactivate`, { reason: 'ย้ายงาน' });
    expect(res.status).toBe(204);

    const { rows } = await pool.query(
      `SELECT r.id, r.status,
              (SELECT l.actor_id FROM supplementary_certificate_request_logs l
               WHERE l.request_id = r.id AND l.action = 'cancel') AS cancelled_by
       FROM supplementary_certificate_requests r WHERE r.user_id = $1`,
      [user.id],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, [r.status, r.cancelled_by]]));
    expect(byId).toEqual({
      [pending]: ['cancelled', admin.id],
      [approved]: ['cancelled', admin.id],
      [rejected]: ['rejected', null],
    });
  });

  it('ลบบัญชี (PDPA) → ล้างวัตถุประสงค์และบันทึกของผู้อนุมัติ คงแถวไว้', async () => {
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const user = await requester({ email: 'gone@msu.ac.th' });
    const id = (await submit(user.cookie)).body.request.id;
    const { cookie } = await approver();
    await post(cookie, `/admin/supplementary-certificate-requests/${id}/reject`, { note: 'ชื่อผู้ขอ: ...' });

    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', await loginAs(admin.id))
      .set('Origin', ORIGIN)
      .send({ confirmEmail: 'gone@msu.ac.th', reason: 'ขอลบข้อมูล' });
    expect(res.status).toBe(204);

    const { rows } = await pool.query(
      'SELECT purpose, decision_note, status FROM supplementary_certificate_requests WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ purpose: '', decision_note: null, status: 'rejected' }]);
  });
});

it('log คำขอแก้/ลบไม่ได้ (append-only)', async () => {
  const user = await requester();
  await submit(user.cookie);
  await expect(pool.query('DELETE FROM supplementary_certificate_request_logs')).rejects.toThrow();
  await expect(pool.query("UPDATE supplementary_certificate_request_logs SET action = 'cancel'")).rejects.toThrow();
});
