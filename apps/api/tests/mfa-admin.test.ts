import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { resetMfaByEmail } from '../src/services/mfa-service.js';
import { createTestRole, createUser, loginAs, queuedEmails, resetDatabase } from './helpers/db.js';
import { base32Decode, codeFor } from './helpers/mfa.js';

// นโยบาย MFA ของผู้ดูแล (docs/design/mfa.md): บังคับ MFA ต่อ role, รีเซ็ต MFA ของผู้อื่น, สคริปต์ mfa:reset — ฐานข้อมูลจริง app_test

const app = createApp();
const ORIGIN = 'http://localhost:3010';

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

const call = (method: 'post' | 'put', path: string, cookie: string, body: object = {}) =>
  request(app)[method](path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

/** เปิด MFA ผ่าน API จริง */
async function enroll(userId: string) {
  const cookie = await loginAs(userId);
  const secret = base32Decode((await call('post', '/me/mfa/totp/setup', cookie)).body.secret);
  expect((await call('post', '/me/mfa/totp/confirm', cookie, { code: codeFor(secret) })).status).toBe(200);
  return cookie;
}

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const auditActions = async (userId: string) =>
  (
    await pool.query<{ action: string; actorId: string | null; reason: string | null }>(
      `SELECT action, actor_id AS "actorId", reason FROM user_audit_logs WHERE target_user_id = $1 ORDER BY created_at, id`,
      [userId],
    )
  ).rows;

const hasMfa = async (userId: string) =>
  (await pool.query(`SELECT 1 FROM user_mfa_totp WHERE user_id = $1`, [userId])).rowCount === 1;
const sessionCount = async (userId: string) =>
  (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`, [userId])).rows[0]!.n;

describe('บังคับ MFA ต่อ role (/admin/roles)', () => {
  // role ที่ super_admin ในไฟล์นี้ไม่ได้ถือ (เปิดแล้วตัวเองจะถูกบังคับตั้งค่าด้วย)
  const path = '/admin/role-permissions/roles/student/mfa-required';

  it('super_admin เท่านั้น / เปิดแล้วผู้ถือ role ต้องตั้งค่า + log / ค่าเดิม → NO_CHANGES', async () => {
    const codes = (await pool.query<{ code: string }>('SELECT code FROM permissions')).rows.map((r) => r.code);
    await createTestRole('test_everything', codes);
    const notSuper = await createUser({ roles: ['user', 'staff', 'test_everything'] });
    expect((await call('put', path, await loginAs(notSuper.id), { required: true, reason: 'x' })).status).toBe(403);

    const admin = await superAdmin();
    const staff = await createUser({ accountType: 'student', roles: ['user', 'student'] });
    const staffCookie = await loginAs(staff.id);
    expect((await request(app).get('/me/notifications').set('Cookie', staffCookie)).status).toBe(200);

    const res = await call('put', path, admin.cookie, { required: true, reason: 'นโยบายความปลอดภัย' });
    expect(res.status).toBe(200);
    expect(res.body.roles.find((r: { code: string }) => r.code === 'student').mfaRequired).toBe(true);
    expect(res.body.logs[0]).toMatchObject({
      action: 'mfa_required',
      role: { code: 'student' },
      detail: { from: false, to: true },
      reason: 'นโยบายความปลอดภัย',
    });
    // มีผลกับ request ถัดไปทันที
    const blocked = await request(app).get('/me/notifications').set('Cookie', staffCookie);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    expect((await call('put', path, admin.cookie, { required: true, reason: 'x' })).body.error.code).toBe('NO_CHANGES');
  });

  it('ปิดการบังคับต้องยืนยันตัวตนซ้ำเสมอ (แม้ปิดกลุ่ม role ไว้) / เปิดไม่ต้องเมื่อปิดกลุ่ม', async () => {
    const admin = await superAdmin();
    await pool.query(`UPDATE system_settings SET mfa_step_up_actions = '{}'`);
    await pool.query(`UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [admin.id]);

    expect((await call('put', path, admin.cookie, { required: true, reason: 'x' })).status).toBe(200);
    const off = await call('put', path, admin.cookie, { required: false, reason: 'x' });
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('RECENT_LOGIN_REQUIRED');
    const { rows } = await pool.query<{ required: boolean }>(`SELECT mfa_required AS required FROM roles WHERE code = 'student'`);
    expect(rows[0]!.required).toBe(true);
  });
});

describe('รีเซ็ต MFA ของผู้อื่น (POST /admin/users/:id/mfa/reset)', () => {
  it('ไม่มี user_mfa:reset → 403 / มี → ลบ MFA, ออกจากระบบทุกอุปกรณ์, audit + แจ้งเจ้าของ', async () => {
    const target = await createUser({ roles: ['user', 'staff'] });
    await enroll(target.id);
    await loginAs(target.id);

    await createTestRole('test_user_read', ['user:read']);
    const reader = await createUser({ roles: ['user', 'staff', 'test_user_read'] });
    const readerCookie = await loginAs(reader.id);
    expect((await call('post', `/admin/users/${target.id}/mfa/reset`, readerCookie, { reason: 'x' })).status).toBe(403);
    // ผู้ดูแลเห็นสถานะเพื่อแสดงปุ่ม
    expect((await request(app).get(`/admin/users/${target.id}`).set('Cookie', readerCookie)).body.mfaEnabled).toBe(true);

    await createTestRole('test_mfa_reset', ['user:read', 'user_mfa:reset']);
    const helpdesk = await createUser({ roles: ['user', 'staff', 'test_mfa_reset'] });
    const cookie = await loginAs(helpdesk.id);
    expect((await call('post', `/admin/users/${target.id}/mfa/reset`, cookie, { reason: '' })).status).toBe(400);
    const res = await call('post', `/admin/users/${target.id}/mfa/reset`, cookie, { reason: 'โทรศัพท์หาย' });
    expect(res.status).toBe(204);

    expect(await hasMfa(target.id)).toBe(false);
    expect(await sessionCount(target.id)).toBe(0);
    expect((await auditActions(target.id)).at(-1)).toEqual({ action: 'mfa_reset', actorId: helpdesk.id, reason: 'โทรศัพท์หาย' });
    expect((await queuedEmails(target.id)).at(-1)).toEqual({ template: 'mfa_reset_by_admin', params: { reason: 'โทรศัพท์หาย' } });

    // ยังไม่เปิด → 409
    const again = await call('post', `/admin/users/${target.id}/mfa/reset`, cookie, { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MFA_NOT_ENABLED');
  });

  it('บัญชีผู้ดูแล (role สิทธิ์สูง) รีเซ็ตได้เฉพาะ super_admin', async () => {
    const target = await createUser({ roles: ['user', 'staff', 'admin'] });
    await enroll(target.id);
    await createTestRole('test_mfa_reset', ['user_mfa:reset']);
    const helpdesk = await createUser({ roles: ['user', 'staff', 'test_mfa_reset'] });
    const denied = await call('post', `/admin/users/${target.id}/mfa/reset`, await loginAs(helpdesk.id), { reason: 'x' });
    expect(denied.body.error.code).toBe('PRIVILEGED_TARGET');
    expect(await hasMfa(target.id)).toBe(true);

    const admin = await superAdmin();
    expect((await call('post', `/admin/users/${target.id}/mfa/reset`, admin.cookie, { reason: 'x' })).status).toBe(204);
    expect(await hasMfa(target.id)).toBe(false);
  });

  it('ต้องยืนยันตัวตนซ้ำ (กลุ่ม user_admin)', async () => {
    const target = await createUser();
    await enroll(target.id);
    const admin = await superAdmin();
    await pool.query(`UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [admin.id]);
    const res = await call('post', `/admin/users/${target.id}/mfa/reset`, admin.cookie, { reason: 'x' });
    expect(res.body.error.code).toBe('RECENT_LOGIN_REQUIRED');
    expect(await hasMfa(target.id)).toBe(true);
  });
});

describe('สคริปต์ mfa:reset', () => {
  it('รีเซ็ตด้วยอีเมล — audit โดยระบบ (actor = NULL) / ไม่พบ / ยังไม่เปิด', async () => {
    const user = await createUser({ email: 'boss@msu.ac.th', roles: ['user', 'staff', 'super_admin'] });
    expect(await resetMfaByEmail('nobody@msu.ac.th', 'x')).toEqual({ ok: false, reason: 'USER_NOT_FOUND' });
    expect(await resetMfaByEmail('boss@msu.ac.th', 'x')).toEqual({ ok: false, reason: 'MFA_NOT_ENABLED' });

    await enroll(user.id);
    expect(await resetMfaByEmail('boss@msu.ac.th', 'super_admin คนเดียวทำโทรศัพท์หาย')).toMatchObject({
      ok: true,
      userId: user.id,
      revokedSessions: 1,
    });
    expect(await hasMfa(user.id)).toBe(false);
    expect((await auditActions(user.id)).at(-1)).toEqual({
      action: 'mfa_reset',
      actorId: null,
      reason: 'super_admin คนเดียวทำโทรศัพท์หาย',
    });
  });
});
