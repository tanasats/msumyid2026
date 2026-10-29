import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SignerError, signer, type IssuedCertificate } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ใบรับรองประจำตัวแบบส่งคำขอ: certificate:apply → certificate:approve อนุมัติ → ผู้ขอรับใบ
// และการตั้งวิธีขอใบของ role (ปิด / ส่งคำขอ / สร้างเองได้) — super_admin เท่านั้น
// mock เฉพาะบริการเซ็น ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

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

const mockSigner = () => vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => fakeIssued());

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

/** นิสิตที่ role student ถูกตั้งเป็น "ส่งคำขอ" ผ่าน role ทดสอบ (ไม่แตะ role ระบบ) */
async function applicant(input: Parameters<typeof createUser>[0] = {}) {
  await createTestRole('test_apply', ['certificate:apply']).catch(() => {});
  const user = await createUser({ accountType: 'student', roles: ['user', 'student', 'test_apply'], ...input });
  return { ...user, cookie: await loginAs(user.id) };
}

async function approver() {
  await createTestRole('test_approve', ['certificate:approve']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_approve'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const submit = (cookie: string, body: object = {}) => post(cookie, '/me/primary-certificate-requests', body);
const approve = (cookie: string, id: string, body: object = {}) =>
  post(cookie, `/admin/primary-certificate-requests/${id}/approve`, body);
const claim = (cookie: string, id: string) =>
  post(cookie, `/me/primary-certificate-requests/${id}/certificate`, { p12Password: PASSWORD });

async function approvedRequest(user: { cookie: string }) {
  const res = await submit(user.cookie);
  expect(res.status).toBe(201);
  const { cookie } = await approver();
  expect((await approve(cookie, res.body.request.id)).status).toBe(200);
  return res.body.request.id as string;
}

async function insertActivePrimary(userId: string, notAfter = new Date(Date.now() + 300 * DAY)) {
  const issued = fakeIssued();
  await pool.query(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'ทดสอบ', 'x@msu.ac.th', now(), $3, 'issued', $4, $5)`,
    [userId, issued.serialNumber, notAfter, issued.certificatePem, issued.fingerprintSha256],
  );
}

describe('ตั้งวิธีขอใบประจำตัวของ role (super_admin เท่านั้น)', () => {
  const setMode = (cookie: string, code: string, mode: string, reason = 'เปิดให้นิสิตขอใบรับรอง') =>
    request(app)
      .put(`/admin/role-permissions/roles/${code}/certificate-mode`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send({ mode, reason });

  it('ปิด → ส่งคำขอ → สร้างเองได้ → ปิด: สิทธิ์ของนิสิตเปลี่ยนทันที และสิทธิ์อื่นของ role คงเดิม', async () => {
    const admin = await superAdmin();
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = 'student' AND p.code = 'document:sign'`,
    );
    const student = await createUser({ accountType: 'student', roles: ['user', 'student'] });
    const cookie = await loginAs(student.id);
    const permissions = async () =>
      [...(await request(app).get('/auth/me').set('Cookie', cookie)).body.user.permissions].sort();

    expect(await permissions()).toEqual(['document:sign']);
    expect((await setMode(admin.cookie, 'student', 'apply')).body).toMatchObject({ granted: ['certificate:apply'], revoked: [] });
    expect(await permissions()).toEqual(['certificate:apply', 'document:sign']);
    expect((await setMode(admin.cookie, 'student', 'self')).body).toMatchObject({
      granted: ['certificate:request'],
      revoked: ['certificate:apply'],
    });
    expect(await permissions()).toEqual(['certificate:request', 'document:sign']);
    await setMode(admin.cookie, 'student', 'off');
    expect(await permissions()).toEqual(['document:sign']);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM role_permission_logs WHERE actor_id = $1", [admin.id]);
    expect(rows[0].n).toBe(4);
  });

  it('ไม่ใช่ super_admin → 403 / super_admin role → 409 / ค่าเดิม → 400 / mode ผิด หรือไม่มีเหตุผล → 400', async () => {
    const user = await approver();
    expect((await setMode(user.cookie, 'student', 'apply')).status).toBe(403);
    const admin = await superAdmin();
    expect((await setMode(admin.cookie, 'super_admin', 'apply')).body.error.code).toBe('SUPER_ADMIN_HAS_ALL');
    expect((await setMode(admin.cookie, 'student', 'off')).body.error.code).toBe('NO_CHANGES');
    expect((await setMode(admin.cookie, 'student', 'maybe')).status).toBe(400);
    expect((await setMode(admin.cookie, 'student', 'apply', ' ')).status).toBe(400);
  });
});

describe('ส่งคำขอ (certificate:apply)', () => {
  it('ไม่มี permission → 403 / มี → 201 รออนุมัติ พร้อม log / ดูได้เฉพาะคำขอของตัวเอง', async () => {
    const none = await createUser({ accountType: 'student', roles: ['user', 'student'] });
    expect((await submit(await loginAs(none.id))).status).toBe(403);

    const user = await applicant();
    const other = await applicant();
    const res = await submit(user.cookie, { purpose: '  ใช้ลงนามรายงานฝึกงาน  ' });
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ status: 'pending', purpose: 'ใช้ลงนามรายงานฝึกงาน', decidedBy: null });
    await submit(other.cookie);

    const mine = await request(app).get('/me/primary-certificate-requests').set('Cookie', user.cookie);
    expect(mine.body.requests.map((r: { id: string }) => r.id)).toEqual([res.body.request.id]);
    const { rows } = await pool.query('SELECT action, actor_id FROM primary_certificate_request_logs WHERE request_id = $1', [
      res.body.request.id,
    ]);
    expect(rows).toEqual([{ action: 'submit', actor_id: user.id }]);
  });

  it('วัตถุประสงค์ไม่บังคับ / คำขอค้างได้ 1 รายการ (ส่งพร้อมกันได้ 1) / มีใบที่ใช้งานอยู่และยังไม่ถึงช่วงต่ออายุ → 409', async () => {
    const user = await applicant();
    const results = await Promise.all([1, 2, 3].map(() => submit(user.cookie)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.find((r) => r.status === 201)!.body.request.purpose).toBeNull();
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('REQUEST_EXISTS');

    const holder = await applicant();
    await insertActivePrimary(holder.id);
    expect((await submit(holder.cookie)).body.error.code).toBe('PRIMARY_CERTIFICATE_EXISTS');
  });
});

describe('อนุมัติ / ปฏิเสธ (certificate:approve)', () => {
  it('ไม่มี permission → 403 / คิวรออนุมัติพร้อมผู้ขอ / อนุมัติ → ผู้ขอเห็นผู้อนุมัติและวันสุดท้ายที่รับใบ', async () => {
    const user = await applicant({ name: 'นิสิต ทดสอบ' });
    const { body } = await submit(user.cookie);
    expect((await approve(user.cookie, body.request.id)).status).toBe(403);

    const actor = await approver();
    const queue = await request(app).get('/admin/primary-certificate-requests').set('Cookie', actor.cookie);
    expect(queue.body.pendingCount).toBe(1);
    expect(queue.body.requests[0]).toMatchObject({ id: body.request.id, requester: { displayName: 'นิสิต ทดสอบ', accountType: 'student' } });

    const res = await approve(actor.cookie, body.request.id, { note: 'อนุมัติตามคำขอ' });
    expect(res.body.request).toMatchObject({ status: 'approved', decidedBy: { id: actor.id }, decisionNote: 'อนุมัติตามคำขอ' });
    const until = Date.parse(res.body.request.claimableUntil) - Date.parse(res.body.request.decidedAt);
    expect(until).toBe(30 * DAY);
    expect((await approve(actor.cookie, body.request.id)).body.error.code).toBe('REQUEST_NOT_PENDING');
  });

  it('ปฏิเสธต้องมีเหตุผล (ผู้ขอเห็น) แล้วส่งคำขอใหม่ได้ / กฎ canManageUser: ผู้อนุมัติอนุมัติคำขอตัวเองไม่ได้ แต่ super_admin ได้', async () => {
    const user = await applicant();
    const { body } = await submit(user.cookie);
    const actor = await approver();
    const path = `/admin/primary-certificate-requests/${body.request.id}/reject`;
    expect((await post(actor.cookie, path, { note: ' ' })).status).toBe(400);
    expect((await post(actor.cookie, path, { note: 'ยังไม่ผ่านการตรวจสอบสถานภาพ' })).body.request).toMatchObject({
      status: 'rejected',
      decisionNote: 'ยังไม่ผ่านการตรวจสอบสถานภาพ',
    });
    expect((await submit(user.cookie)).status).toBe(201);

    await createTestRole('test_both', ['certificate:apply', 'certificate:approve']);
    const self = await createUser({ roles: ['user', 'staff', 'test_both'] });
    const selfCookie = await loginAs(self.id);
    const own = await submit(selfCookie);
    expect((await approve(selfCookie, own.body.request.id)).body.error.code).toBe('CANNOT_MANAGE_SELF');

    const admin = await superAdmin();
    const adminOwn = await submit(admin.cookie);
    expect((await approve(admin.cookie, adminOwn.body.request.id)).status).toBe(200);
  });
});

describe('รับใบรับรอง', () => {
  it('ยังไม่อนุมัติ → 409 และไม่เรียก signer', async () => {
    const issue = mockSigner();
    const user = await applicant();
    const { body } = await submit(user.cookie);
    expect((await claim(user.cookie, body.request.id)).body.error.code).toBe('REQUEST_NOT_APPROVED');
    expect(issue).not.toHaveBeenCalled();
  });

  it('สำเร็จ: ออกใบประจำตัวอายุตามนโยบาย + key สำรอง, คำขอเป็น issued, รับซ้ำ → 409 / จัดการใบของตัวเองได้ด้วย certificate:apply', async () => {
    const issue = mockSigner();
    const user = await applicant({ name: 'สมศรี ขยันเรียน', email: '66011234567@msu.ac.th' });
    const id = await approvedRequest(user);

    const res = await claim(user.cookie, id);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(issue).toHaveBeenCalledWith({
      commonName: 'สมศรี ขยันเรียน',
      email: '66011234567@msu.ac.th',
      p12Password: PASSWORD,
      legacyP12: false,
      validityDays: 365,
    });
    expect(res.body.certificate).toMatchObject({ kind: 'primary', status: 'active', hasKeyEscrow: true });

    const { rows } = await pool.query(
      `SELECT r.status, c.kind, c.user_id FROM primary_certificate_requests r JOIN certificates c ON c.id = r.certificate_id WHERE r.id = $1`,
      [id],
    );
    expect(rows).toEqual([{ status: 'issued', kind: 'primary', user_id: user.id }]);
    expect((await claim(user.cookie, id)).body.error.code).toBe('REQUEST_ALREADY_ISSUED');

    // ผู้ที่ได้ใบผ่านคำขอ (ไม่มี certificate:request) ดาวน์โหลดใหม่และเพิกถอนใบของตัวเองได้
    vi.spyOn(signer, 'rebuildP12').mockResolvedValue(Buffer.from('rebuilt'));
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const certId = res.body.certificate.id;
    expect((await post(user.cookie, `/me/certificates/${certId}/p12`, { p12Password: PASSWORD })).status).toBe(200);
    expect((await post(user.cookie, `/me/certificates/${certId}/revoke`, { reason: 'keyCompromise' })).status).toBe(200);
  });

  it('กดรับพร้อมกัน → ได้ใบเดียว / คำขอของคนอื่น → 404', async () => {
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return fakeIssued();
    });
    const user = await applicant();
    const id = await approvedRequest(user);
    const other = await applicant();
    expect((await claim(other.cookie, id)).status).toBe(404);
    const results = await Promise.all([1, 2, 3].map(() => claim(user.cookie, id)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  it('อนุมัติเกิน 30 วันแล้วไม่ได้รับ → หมดเวลารับใบ (409) ไม่นับเป็นคำขอค้าง ส่งใหม่ได้', async () => {
    const issue = mockSigner();
    const user = await applicant();
    const id = await approvedRequest(user);
    await pool.query("UPDATE primary_certificate_requests SET decided_at = now() - interval '31 days' WHERE id = $1", [id]);

    const list = await request(app).get('/me/primary-certificate-requests').set('Cookie', user.cookie);
    expect(list.body.requests[0].status).toBe('expired');
    expect((await claim(user.cookie, id)).body.error.code).toBe('REQUEST_EXPIRED');
    expect(issue).not.toHaveBeenCalled();
    expect((await submit(user.cookie)).status).toBe(201);
  });

  it('ระหว่างรออนุมัติได้ใบประจำตัวทางอื่นแล้ว → รับใบไม่ได้ (409 PRIMARY_CERTIFICATE_EXISTS) / signer ล่ม → 503 คำขอยังรอรับ', async () => {
    mockSigner();
    const user = await applicant();
    const id = await approvedRequest(user);
    await insertActivePrimary(user.id);
    expect((await claim(user.cookie, id)).body.error.code).toBe('PRIMARY_CERTIFICATE_EXISTS');

    const other = await applicant();
    const otherId = await approvedRequest(other);
    vi.spyOn(signer, 'issueCertificate').mockRejectedValueOnce(new SignerError('ล่ม'));
    expect((await claim(other.cookie, otherId)).status).toBe(503);
    const { rows } = await pool.query('SELECT status FROM primary_certificate_requests WHERE id = $1', [otherId]);
    expect(rows[0].status).toBe('approved');
  });
});

describe('ยกเลิก / ปิดบัญชี / ลบบัญชี', () => {
  it('ผู้ขอยกเลิกได้ / ปิดบัญชี → คำขอที่ค้างถูกยกเลิกพร้อม log ผู้ทำ', async () => {
    const user = await applicant();
    const first = (await submit(user.cookie)).body.request.id;
    expect((await post(user.cookie, `/me/primary-certificate-requests/${first}/cancel`)).body.request.status).toBe('cancelled');
    const pending = (await submit(user.cookie)).body.request.id;

    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const admin = await superAdmin();
    expect((await post(admin.cookie, `/admin/users/${user.id}/deactivate`, { reason: 'พ้นสภาพ' })).status).toBe(204);
    const { rows } = await pool.query(
      `SELECT r.status, l.actor_id FROM primary_certificate_requests r
       JOIN primary_certificate_request_logs l ON l.request_id = r.id AND l.action = 'cancel'
       WHERE r.id = $1`,
      [pending],
    );
    expect(rows).toEqual([{ status: 'cancelled', actor_id: admin.id }]);
  });

  it('ลบบัญชี (PDPA) → ล้างวัตถุประสงค์และบันทึกของผู้อนุมัติ / log แก้หรือลบไม่ได้', async () => {
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const user = await applicant({ email: '66019999999@msu.ac.th' });
    const id = (await submit(user.cookie, { purpose: 'ข้อมูลส่วนตัว' })).body.request.id;
    const { cookie } = await approver();
    await post(cookie, `/admin/primary-certificate-requests/${id}/reject`, { note: 'บันทึก' });

    const admin = await superAdmin();
    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .send({ confirmEmail: '66019999999@msu.ac.th', reason: 'ขอลบข้อมูล' });
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT purpose, decision_note, status FROM primary_certificate_requests WHERE id = $1', [id]);
    expect(rows).toEqual([{ purpose: null, decision_note: null, status: 'rejected' }]);
    await expect(pool.query('DELETE FROM primary_certificate_request_logs')).rejects.toThrow();
  });
});
