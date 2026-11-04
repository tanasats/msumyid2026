import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createUser, loginAs, resetDatabase } from './helpers/db.js';
import { base32Decode, codeFor } from './helpers/mfa.js';

// ยืนยันตัวตนซ้ำก่อนรายการสำคัญ (reauth-service, docs/design/mfa.md) — ฐานข้อมูลจริง app_test
// ตรวจเฉพาะด่าน step-up: ผ่านด่านแล้ว endpoint จะตอบอะไรต่อ (404/400) ไม่สำคัญในไฟล์นี้

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const STEP_UP_CODES = ['MFA_STEP_UP_REQUIRED', 'RECENT_LOGIN_REQUIRED'];

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

const call = (method: string, path: string, cookie: string, body: object = {}) =>
  request(app)[method as 'post'](path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

/** เปิด MFA ผ่าน API จริง — session ที่ใช้ตั้งค่านับว่ายืนยันแล้ว */
async function enroll(userId: string) {
  const cookie = await loginAs(userId);
  const secret = base32Decode((await call('post', '/me/mfa/totp/setup', cookie)).body.secret);
  expect((await call('post', '/me/mfa/totp/confirm', cookie, { code: codeFor(secret) })).status).toBe(200);
  return { secret, cookie };
}

const ageLogin = (userId: string) =>
  pool.query(`UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [userId]);
const ageMfa = (userId: string) =>
  pool.query(`UPDATE sessions SET mfa_verified_at = now() - interval '11 minutes' WHERE user_id = $1`, [userId]);
const setStepUpActions = (actions: string[]) =>
  pool.query(`UPDATE system_settings SET mfa_step_up_actions = $1`, [actions]);

/** รายการที่ต้องยืนยันซ้ำ แยกตามกลุ่มที่ super_admin เปิด/ปิด */
function guardedRequests(targetId: string) {
  const id = randomUUID();
  return [
    ['post', '/me/certificates'],
    ['post', `/me/certificates/${id}/p12`],
    ['post', `/me/primary-certificate-requests/${id}/certificate`],
    ['post', `/me/supplementary-certificate-requests/${id}/certificate`],
    ['post', `/admin/users/${targetId}/roles/staff`],
    ['delete', `/admin/users/${targetId}/roles/staff`],
    ['post', '/admin/role-permissions/roles'],
    ['patch', '/admin/role-permissions/roles/staff'],
    ['put', '/admin/role-permissions/roles/staff/permissions'],
    ['put', '/admin/role-permissions/roles/staff/certificate-mode'],
    ['put', '/admin/system-settings'],
    ['delete', `/admin/users/${targetId}`],
  ] as const;
}

describe('ผู้ที่ไม่เปิด MFA — ใช้การ login ภายใน 10 นาที', () => {
  it('login นานแล้ว → 403 RECENT_LOGIN_REQUIRED ทุกรายการ / เพิ่ง login → ผ่านด่าน', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const target = await createUser();
    const fresh = await loginAs(admin.id);
    for (const [method, path] of guardedRequests(target.id)) {
      expect(STEP_UP_CODES, `${method} ${path}`).not.toContain((await call(method, path, fresh)).body.error?.code);
    }

    await ageLogin(admin.id);
    for (const [method, path] of guardedRequests(target.id)) {
      const res = await call(method, path, fresh);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe('RECENT_LOGIN_REQUIRED');
    }
    // รายการอื่นใช้ได้ตามปกติ
    expect((await request(app).get('/me/certificates').set('Cookie', fresh)).status).toBe(200);
  });

  it('super_admin ปิดทุกกลุ่ม → ไม่ต้องยืนยันซ้ำ', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const target = await createUser();
    const cookie = await loginAs(admin.id);
    await ageLogin(admin.id);
    await setStepUpActions([]);
    for (const [method, path] of guardedRequests(target.id)) {
      expect(STEP_UP_CODES, `${method} ${path}`).not.toContain((await call(method, path, cookie)).body.error?.code);
    }
  });

  it('ปิดเฉพาะกลุ่ม certificate → กลุ่มอื่นยังต้องยืนยัน', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const target = await createUser();
    const cookie = await loginAs(admin.id);
    await ageLogin(admin.id);
    await setStepUpActions(['role', 'system_settings', 'user_admin']);
    expect((await call('post', `/me/certificates/${randomUUID()}/p12`, cookie)).body.error.code).not.toBe(
      'RECENT_LOGIN_REQUIRED',
    );
    expect((await call('delete', `/admin/users/${target.id}`, cookie)).body.error.code).toBe('RECENT_LOGIN_REQUIRED');
  });
});

describe('ผู้ที่เปิด MFA — ต้องใส่รหัสภายใน 10 นาที', () => {
  it('ยืนยันนานแล้ว → MFA_STEP_UP_REQUIRED (แม้เพิ่ง login) / ใส่รหัสที่ /auth/mfa/step-up → ผ่าน', async () => {
    const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const { secret, cookie } = await enroll(user.id);
    const path = `/me/certificates/${randomUUID()}/p12`;
    expect(STEP_UP_CODES).not.toContain((await call('post', path, cookie)).body.error?.code);

    await ageMfa(user.id);
    const blocked = await call('post', path, cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_STEP_UP_REQUIRED');

    expect((await call('post', '/auth/mfa/step-up', cookie, { code: codeFor(secret, 1) })).status).toBe(204);
    expect(STEP_UP_CODES).not.toContain((await call('post', path, cookie)).body.error?.code);
  });
});

describe('รายการที่ต้องยืนยันซ้ำเสมอ (ไม่ขึ้นกับสวิตช์)', () => {
  const settings = {
    allowedEmailDomains: ['msu.ac.th'],
    sessionTtlDays: 7,
    crlValidityDays: 7,
    crlReissueHours: 24,
    primaryReissueLimit: 2,
    reason: 'ทดสอบ',
  };

  it('แก้รายการที่ต้องยืนยันซ้ำ → ต้องยืนยันแม้ปิดกลุ่ม system_settings / แก้ค่าอื่นไม่ต้อง', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const cookie = await loginAs(admin.id);
    await ageLogin(admin.id);
    await setStepUpActions([]);

    const other = await call('put', '/admin/system-settings', cookie, { ...settings, sessionTtlDays: 3, mfaStepUpActions: [] });
    expect(other.status).toBe(200);
    const toggle = await call('put', '/admin/system-settings', cookie, { ...settings, mfaStepUpActions: ['certificate'] });
    expect(toggle.status).toBe(403);
    expect(toggle.body.error.code).toBe('RECENT_LOGIN_REQUIRED');
    const { rows } = await pool.query<{ actions: string[] }>(`SELECT mfa_step_up_actions AS actions FROM system_settings`);
    expect(rows[0]!.actions).toEqual([]);
  });

  it('ตั้ง PIN ลงนามใหม่โดยไม่ใส่ PIN เดิม: ปิดทุกกลุ่มก็ยังต้องยืนยัน / ผู้เปิด MFA ใช้รหัสแทนการ login ใหม่ได้', async () => {
    const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const { secret, cookie } = await enroll(user.id);
    expect((await call('put', '/me/signing-pin', cookie, { newPin: '739204' })).status).toBe(200);
    await setStepUpActions([]);

    await ageMfa(user.id);
    const blocked = await call('put', '/me/signing-pin', cookie, { newPin: '582047' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_STEP_UP_REQUIRED');

    expect((await call('post', '/auth/mfa/step-up', cookie, { code: codeFor(secret, 1) })).status).toBe(204);
    expect((await call('put', '/me/signing-pin', cookie, { newPin: '582047' })).status).toBe(200);
  });
});
