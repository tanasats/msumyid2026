import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// คำขอเพิกถอนใบรับรองประจำตัว (ตัดสินใจ 2026-10-29): keyCompromise เพิกถอนเองทันที เหตุผลอื่นรอผู้มี certificate:revoke อนุมัติ
// mock เฉพาะบริการเซ็น (ออก CRL) ฐานข้อมูลใช้ app_test จริง

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
const get = (cookie: string, path: string) => request(app).get(path).set('Cookie', cookie);

async function userWith(code: `test_${string}`, permissions: string[], extraRoles: string[] = []) {
  await createTestRole(code, permissions).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', code, ...extraRoles] });
  return { ...user, cookie: await loginAs(user.id) };
}
const requester = () => userWith('test_cert', ['certificate:request']);
const approver = () => userWith('test_revoker', ['certificate:revoke']);

async function insertCertificate(
  userId: string,
  input: { kind?: 'primary' | 'supplementary'; notAfter?: Date } = {},
): Promise<string> {
  const notAfter = input.notAfter ?? new Date(Date.now() + 365 * DAY);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after, source, kind,
                               certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'ทดสอบ', 'test@msu.ac.th', $3, $4, 'issued', $5, '-----BEGIN CERTIFICATE-----', $6)
     RETURNING id`,
    [
      userId,
      `1${randomBytes(15).toString('hex')}`,
      new Date(notAfter.getTime() - 365 * DAY),
      notAfter,
      input.kind ?? 'primary',
      randomBytes(32).toString('hex'),
    ],
  );
  return rows[0]!.id;
}

const certificateState = async (id: string) =>
  (
    await pool.query<{ revoked: boolean; reason: string | null; revoked_by: string | null }>(
      `SELECT revoked_at IS NOT NULL AS revoked, revocation_reason AS reason, revoked_by FROM certificates WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

const requestLogs = async (requestId: string) =>
  (
    await pool.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id FROM certificate_revocation_request_logs WHERE request_id = $1 ORDER BY created_at, id`,
      [requestId],
    )
  ).rows;

const submit = (cookie: string, certificateId: string, reason = 'affiliationChanged') =>
  post(cookie, `/me/certificates/${certificateId}/revocation-requests`, { reason });

describe('เพิกถอนใบประจำตัวของตัวเองตามเหตุผล', () => {
  it('keyCompromise → เพิกถอนทันที / เหตุผลอื่น → 409 REVOCATION_REQUEST_REQUIRED (ใบยังใช้งานอยู่)', async () => {
    const user = await requester();
    const urgent = await insertCertificate(user.id);
    const normal = await insertCertificate(user.id);

    expect((await post(user.cookie, `/me/certificates/${urgent}/revoke`, { reason: 'keyCompromise' })).status).toBe(200);
    expect(await certificateState(urgent)).toMatchObject({ revoked: true, reason: 'keyCompromise' });

    for (const reason of ['superseded', 'affiliationChanged', 'cessationOfOperation']) {
      const res = await post(user.cookie, `/me/certificates/${normal}/revoke`, { reason });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('REVOCATION_REQUEST_REQUIRED');
    }
    expect((await certificateState(normal)).revoked).toBe(false);
  });

  it('ใบเสริมเพิกถอนเองได้ทุกเหตุผล และไม่ต้องส่งคำขอ (409 REVOCATION_REQUEST_NOT_NEEDED)', async () => {
    const user = await userWith('test_supp', ['supplementary_certificate:request']);
    const certificateId = await insertCertificate(user.id, { kind: 'supplementary' });
    expect((await submit(user.cookie, certificateId)).body.error.code).toBe('REVOCATION_REQUEST_NOT_NEEDED');
    expect((await post(user.cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'superseded' })).status).toBe(200);
  });

  it('super_admin (มี certificate:revoke และตัดสินเรื่องของตัวเองได้) เพิกถอนใบประจำตัวของตัวเองได้ทันที', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const cookie = await loginAs(admin.id);
    const certificateId = await insertCertificate(admin.id);
    expect((await get(cookie, '/me/certificate-revocation-requests')).body.canRevokeDirectly).toBe(true);
    expect((await post(cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'superseded' })).status).toBe(200);
  });

  it('ผู้มี certificate:revoke (ไม่ใช่ super_admin) ยังต้องส่งคำขอสำหรับใบของตัวเอง', async () => {
    const user = await userWith('test_both', ['certificate:request', 'certificate:revoke']);
    const certificateId = await insertCertificate(user.id);
    expect((await get(user.cookie, '/me/certificate-revocation-requests')).body.canRevokeDirectly).toBe(false);
    const res = await post(user.cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'superseded' });
    expect(res.body.error.code).toBe('REVOCATION_REQUEST_REQUIRED');
  });
});

describe('ส่ง/ยกเลิกคำขอเพิกถอน', () => {
  it('ส่งคำขอได้ 1 รายการต่อใบ, keyCompromise ส่งเป็นคำขอไม่ได้, ใบของคนอื่น → 404, ไม่มีสิทธิ์ → 403', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);

    expect((await submit(user.cookie, certificateId, 'keyCompromise')).status).toBe(400);
    const res = await submit(user.cookie, certificateId);
    expect(res.status).toBe(201);
    expect(res.body.request).toMatchObject({ status: 'pending', reason: 'affiliationChanged', certificate: { id: certificateId } });
    expect((await submit(user.cookie, certificateId, 'superseded')).body.error.code).toBe('REQUEST_EXISTS');
    expect(await requestLogs(res.body.request.id)).toEqual([{ action: 'submit', actor_id: user.id }]);

    const other = await requester();
    expect((await submit(other.cookie, certificateId)).status).toBe(404);
    const noPermission = await createUser();
    const ownCert = await insertCertificate(noPermission.id);
    expect((await submit(await loginAs(noPermission.id), ownCert)).status).toBe(403);
  });

  it('ใบที่หมดอายุแล้วหรือเพิกถอนแล้ว → 409', async () => {
    const user = await requester();
    const expired = await insertCertificate(user.id, { notAfter: new Date(Date.now() - DAY) });
    expect((await submit(user.cookie, expired)).body.error.code).toBe('CERTIFICATE_EXPIRED');
    const revoked = await insertCertificate(user.id);
    await post(user.cookie, `/me/certificates/${revoked}/revoke`, { reason: 'keyCompromise' });
    expect((await submit(user.cookie, revoked)).body.error.code).toBe('CERTIFICATE_ALREADY_REVOKED');
  });

  it('ผู้ขอยกเลิกคำขอที่รออนุมัติได้ (ของคนอื่น → 404, ยกเลิกซ้ำ → 409) แล้วส่งใหม่ได้', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, certificateId)).body.request;

    const other = await requester();
    expect((await post(other.cookie, `/me/certificate-revocation-requests/${id}/cancel`)).status).toBe(404);
    const res = await post(user.cookie, `/me/certificate-revocation-requests/${id}/cancel`);
    expect(res.body.request.status).toBe('cancelled');
    expect((await post(user.cookie, `/me/certificate-revocation-requests/${id}/cancel`)).body.error.code).toBe(
      'REQUEST_NOT_CANCELLABLE',
    );
    expect((await certificateState(certificateId)).revoked).toBe(false);
    expect((await submit(user.cookie, certificateId)).status).toBe(201);

    const mine = await get(user.cookie, '/me/certificate-revocation-requests');
    expect(mine.body.requests.map((r: { status: string }) => r.status)).toEqual(['pending', 'cancelled']);
  });

  it('รอคำขออยู่แล้วเพิกถอนด่วน (keyCompromise) → ใบถูกเพิกถอนและคำขอถูกยกเลิกอัตโนมัติ', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, certificateId)).body.request;

    await post(user.cookie, `/me/certificates/${certificateId}/revoke`, { reason: 'keyCompromise' });
    const { rows } = await pool.query(`SELECT status FROM certificate_revocation_requests WHERE id = $1`, [id]);
    expect(rows[0]!.status).toBe('cancelled');
    expect((await requestLogs(id)).map((l) => l.action)).toEqual(['submit', 'cancel']);
  });
});

describe('ผู้อนุมัติ (certificate:revoke)', () => {
  it('ไม่มี certificate:revoke → 403 ทั้งดูคิวและตัดสิน', async () => {
    const user = await requester();
    const { id } = (await submit(user.cookie, await insertCertificate(user.id))).body.request;
    const other = await requester();
    expect((await get(other.cookie, '/admin/certificate-revocation-requests')).status).toBe(403);
    expect((await post(other.cookie, `/admin/certificate-revocation-requests/${id}/approve`)).status).toBe(403);
  });

  it('อนุมัติ → เพิกถอนด้วยเหตุผลที่ผู้ขอเลือก (ผู้เพิกถอน = ผู้อนุมัติ) + audit + ออก CRL', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, certificateId, 'superseded')).body.request;
    const admin = await approver();

    const queue = await get(admin.cookie, '/admin/certificate-revocation-requests');
    expect(queue.body.pendingCount).toBe(1);
    expect(queue.body.requests[0]).toMatchObject({ id, requester: { id: user.id }, certificate: { id: certificateId } });

    const res = await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/approve`, { note: 'ตรวจแล้ว' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ crlUpdated: true, request: { status: 'approved', decisionNote: 'ตรวจแล้ว' } });
    expect(await certificateState(certificateId)).toEqual({ revoked: true, reason: 'superseded', revoked_by: admin.id });
    const audit = await pool.query(
      `SELECT action, actor_id, reason FROM certificate_audit_logs WHERE certificate_id = $1`,
      [certificateId],
    );
    expect(audit.rows).toEqual([{ action: 'revoke', actor_id: admin.id, reason: 'ตรวจแล้ว' }]);
    expect(await requestLogs(id)).toEqual([
      { action: 'submit', actor_id: user.id },
      { action: 'approve', actor_id: admin.id },
    ]);
    expect((await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/approve`)).body.error.code).toBe(
      'REQUEST_NOT_PENDING',
    );

    const history = await get(admin.cookie, '/admin/certificate-revocation-requests?view=approved');
    expect(history.body.requests.map((r: { id: string }) => r.id)).toEqual([id]);
  });

  it('ปฏิเสธต้องมีเหตุผล (ผู้ขอเห็น) และใบยังใช้งานอยู่', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, certificateId)).body.request;
    const admin = await approver();

    expect((await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/reject`)).status).toBe(400);
    const res = await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/reject`, { note: 'ใช้ใบเดิมต่อได้' });
    expect(res.body).toMatchObject({ crlUpdated: null, request: { status: 'rejected', decisionNote: 'ใช้ใบเดิมต่อได้' } });
    expect((await certificateState(certificateId)).revoked).toBe(false);
    const mine = await get(user.cookie, '/me/certificate-revocation-requests');
    expect(mine.body.requests[0]).toMatchObject({ status: 'rejected', decisionNote: 'ใช้ใบเดิมต่อได้' });
  });

  it('กฎ canManageUser: คำขอของตัวเองไม่ได้, คำขอของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin, super_admin ตัดสินคำขอตัวเองได้', async () => {
    const self = await userWith('test_both', ['certificate:request', 'certificate:revoke']);
    const ownRequest = (await submit(self.cookie, await insertCertificate(self.id))).body.request.id;
    expect((await post(self.cookie, `/admin/certificate-revocation-requests/${ownRequest}/approve`)).body.error.code).toBe(
      'CANNOT_MANAGE_SELF',
    );

    const privileged = await userWith('test_cert', ['certificate:request'], ['admin']);
    const privilegedRequest = (await submit(privileged.cookie, await insertCertificate(privileged.id))).body.request.id;
    const admin = await approver();
    expect(
      (await post(admin.cookie, `/admin/certificate-revocation-requests/${privilegedRequest}/approve`)).body.error.code,
    ).toBe('PRIVILEGED_TARGET');

    const superAdmin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const superCookie = await loginAs(superAdmin.id);
    expect((await post(superCookie, `/admin/certificate-revocation-requests/${privilegedRequest}/approve`)).status).toBe(200);
  });

  it('ใบหมดอายุระหว่างรออนุมัติ → อนุมัติไม่ได้ (409) แต่ปฏิเสธได้', async () => {
    const user = await requester();
    const certificateId = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, certificateId)).body.request;
    await pool.query(`UPDATE certificates SET not_before = now() - interval '2 days', not_after = now() - interval '1 minute' WHERE id = $1`, [certificateId]);
    const admin = await approver();

    expect((await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/approve`)).body.error.code).toBe(
      'CERTIFICATE_EXPIRED',
    );
    expect((await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/reject`, { note: 'หมดอายุแล้ว' })).status).toBe(
      200,
    );
  });

  it('ผู้ดูแลเพิกถอนใบเอง / ปิดบัญชี → คำขอที่ค้างถูกยกเลิกอัตโนมัติ', async () => {
    const user = await requester();
    const first = await insertCertificate(user.id);
    const second = await insertCertificate(user.id);
    const firstRequest = (await submit(user.cookie, first)).body.request.id;
    const secondRequest = (await submit(user.cookie, second)).body.request.id;
    const admin = await userWith('test_admin', ['certificate:revoke', 'user:deactivate']);

    await post(admin.cookie, `/admin/certificates/${first}/revoke`, { reason: 'affiliationChanged', note: 'ย้ายหน่วยงาน' });
    expect((await requestLogs(firstRequest)).at(-1)).toEqual({ action: 'cancel', actor_id: admin.id });

    const res = await post(admin.cookie, `/admin/users/${user.id}/deactivate`, { reason: 'พ้นสภาพ' });
    expect(res.status).toBe(204);
    const { rows } = await pool.query(`SELECT status FROM certificate_revocation_requests WHERE id = $1`, [secondRequest]);
    expect(rows[0]!.status).toBe('cancelled');
  });
});

describe('โควตาขอใบประจำตัวใหม่หลังเพิกถอน (system_settings.primary_reissue_limit, ค่าเริ่มต้น 2 ครั้ง / 365 วัน)', () => {
  const fakeIssued = () => ({
    certificatePem: '-----BEGIN CERTIFICATE-----\n',
    serialNumber: `1${randomBytes(15).toString('hex')}`,
    fingerprintSha256: randomBytes(32).toString('hex'),
    notBefore: new Date(),
    notAfter: new Date(Date.now() + 365 * DAY),
    p12: Buffer.from('p12'),
    escrow: { kekId: 'test-1', encryptedKey: randomBytes(40), wrappedDataKey: randomBytes(60) },
  });

  /** ใบประจำตัวที่ถูกเพิกถอนแล้ว — revokedBy = ผู้เพิกถอน (เจ้าของ = เพิกถอนเอง) */
  async function revokedPrimary(userId: string, input: { revokedBy: string | null; daysAgo?: number }) {
    const id = await insertCertificate(userId);
    await pool.query(
      `UPDATE certificates
       SET revoked_at = now() - make_interval(days => $2), revocation_reason = 'superseded', revoked_by = $3
       WHERE id = $1`,
      [id, input.daysAgo ?? 1, input.revokedBy],
    );
    return id;
  }

  const issue = (cookie: string) => post(cookie, '/me/certificates', { p12Password: 'password1' });
  const submitPrimary = (cookie: string) => post(cookie, '/me/primary-certificate-requests', {});
  const limitReached = async (cookie: string) =>
    (await get(cookie, '/me/certificates')).body.primaryRequest.reissueLimitReached as boolean;

  it('เพิกถอนเอง 2 ครั้ง → ยังสร้างเองได้ (ส่งคำขอไม่ได้ REQUEST_NOT_NEEDED) / ครั้งที่ 3 → ต้องส่งคำขอ', async () => {
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => fakeIssued());
    const user = await requester();
    await revokedPrimary(user.id, { revokedBy: user.id });
    await revokedPrimary(user.id, { revokedBy: user.id });

    expect(await limitReached(user.cookie)).toBe(false);
    expect((await submitPrimary(user.cookie)).body.error.code).toBe('REQUEST_NOT_NEEDED');
    const ok = await issue(user.cookie);
    expect(ok.status).toBe(201);

    await pool.query(
      `UPDATE certificates SET revoked_at = now(), revocation_reason = 'superseded', revoked_by = $2 WHERE id = $1`,
      [ok.body.certificate.id, user.id],
    );
    expect(await limitReached(user.cookie)).toBe(true);
    const blocked = await issue(user.cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('REISSUE_LIMIT_REACHED');
    expect((await submitPrimary(user.cookie)).status).toBe(201);
  });

  it('ไม่นับ: ผู้ดูแล/ระบบเพิกถอน และที่เกิน 365 วัน / นับ: คำขอเพิกถอนของตัวเองที่ได้รับอนุมัติ', async () => {
    const user = await requester();
    const admin = await approver();
    await revokedPrimary(user.id, { revokedBy: admin.id });
    await revokedPrimary(user.id, { revokedBy: null });
    await revokedPrimary(user.id, { revokedBy: user.id, daysAgo: 366 });
    await revokedPrimary(user.id, { revokedBy: user.id });
    await revokedPrimary(user.id, { revokedBy: user.id });
    expect(await limitReached(user.cookie)).toBe(false);

    const viaRequest = await insertCertificate(user.id);
    const { id } = (await submit(user.cookie, viaRequest)).body.request;
    await post(admin.cookie, `/admin/certificate-revocation-requests/${id}/approve`);
    expect(await limitReached(user.cookie)).toBe(true);
  });

  it('เกินโควตาแล้วส่งคำขอ → อนุมัติ → รับใบได้ (ใบจากคำขอที่อนุมัติไม่ติดโควตา) และโควตา 0 = ต้องส่งคำขอหลังเพิกถอนทุกครั้ง', async () => {
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => fakeIssued());
    await pool.query('UPDATE system_settings SET primary_reissue_limit = 0');
    const user = await requester();
    expect(await limitReached(user.cookie)).toBe(false);
    await revokedPrimary(user.id, { revokedBy: user.id });
    expect((await issue(user.cookie)).body.error.code).toBe('REISSUE_LIMIT_REACHED');

    const { id } = (await submitPrimary(user.cookie)).body.request;
    const approverUser = await userWith('test_approver', ['certificate:approve']);
    expect((await post(approverUser.cookie, `/admin/primary-certificate-requests/${id}/approve`)).status).toBe(200);
    const claim = await post(user.cookie, `/me/primary-certificate-requests/${id}/certificate`, { p12Password: 'password1' });
    expect(claim.status).toBe(201);
  });
});
