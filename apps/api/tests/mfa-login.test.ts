import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { PRIVACY_NOTICE_VERSION } from '../src/services/privacy-service.js';
import { createUser, loginAs, requireMfaForRoles, resetDatabase } from './helpers/db.js';
import { base32Decode, codeFor } from './helpers/mfa.js';
import * as google from './helpers/google.js';

// ด่าน MFA ของ session (docs/design/mfa.md): ยืนยันตอนเข้าสู่ระบบ, role บังคับ, ลำดับการตรวจใน requireAuth — ฐานข้อมูลจริง app_test

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

const post = (path: string, cookie: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
/** endpoint ที่ใช้ requireAuth ธรรมดา */
const protectedGet = (cookie: string) => request(app).get('/me/notifications').set('Cookie', cookie);
const me = (cookie: string) => request(app).get('/auth/me').set('Cookie', cookie);

/** เปิด MFA ให้ผู้ใช้ผ่าน API จริง แล้วคืน secret และรหัสกู้คืน */
async function enroll(userId: string) {
  const cookie = await loginAs(userId);
  const secret = base32Decode((await post('/me/mfa/totp/setup', cookie)).body.secret);
  const confirm = await post('/me/mfa/totp/confirm', cookie, { code: codeFor(secret) });
  expect(confirm.status).toBe(200);
  return { secret, recoveryCodes: confirm.body.recoveryCodes as string[], cookie };
}

describe('เข้าสู่ระบบเมื่อเปิด MFA', () => {
  it('session ใหม่ใช้ระบบไม่ได้จนกว่าจะใส่รหัส / /auth/me ไม่คืน role และ permission', async () => {
    const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const { secret, cookie: enrollCookie } = await enroll(user.id);
    // session ที่ตั้งค่าเองนับว่ายืนยันแล้ว
    expect((await protectedGet(enrollCookie)).status).toBe(200);

    const cookie = await loginAs(user.id);
    const blocked = await protectedGet(cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');
    // กดรับทราบประกาศก็ไม่ได้
    expect((await post('/me/privacy-acknowledgement', cookie, { version: 1 })).body.error.code).toBe('MFA_REQUIRED');

    const current = await me(cookie);
    expect(current.status).toBe(200);
    expect(current.body.user.mfa).toEqual({ enabled: true, required: false, verified: false });
    expect(current.body.user.roles).toEqual([]);
    expect(current.body.user.permissions).toEqual([]);
    expect(current.body.user.capabilities).toEqual({ manageRoles: false, manageSettings: false });

    const wrong = await post('/auth/mfa/verify', cookie, { code: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('MFA_CODE_INCORRECT');

    const ok = await post('/auth/mfa/verify', cookie, { code: codeFor(secret, 1) });
    expect(ok.status).toBe(200);
    expect(ok.body.method).toBe('totp');
    const rotated = google.sessionCookieFrom(ok);
    expect(rotated).toBeDefined();
    const newCookie = rotated!.split(';')[0]!;
    expect(newCookie).not.toBe(cookie);

    // token ก่อนยืนยันใช้ไม่ได้แล้ว (กัน session fixation) / token ใหม่ใช้ได้
    expect((await me(cookie)).status).toBe(401);
    expect((await protectedGet(newCookie)).status).toBe(200);
    const after = await me(newCookie);
    expect(after.body.user.mfa.verified).toBe(true);
    expect(after.body.user.roles).toContain('super_admin');
  });

  it('ใช้รหัสกู้คืนแทนได้', async () => {
    const user = await createUser();
    const { recoveryCodes } = await enroll(user.id);
    const cookie = await loginAs(user.id);
    const res = await post('/auth/mfa/verify', cookie, { code: recoveryCodes[3]! });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('recovery_code');
  });

  it('login ผ่าน Google จริง → session ยังไม่ยืนยัน MFA', async () => {
    // นิสิต (ตัวเลข 11 หลัก) — ไม่เรียก ERP-HR
    const sub = 'google-sub-mfa-1';
    const email = '64010000001@msu.ac.th';
    const first = await google.loginWith(app, { sub, email });
    const firstCookie = google.sessionCookieFrom(first.res)!.split(';')[0]!;
    expect((await post('/me/privacy-acknowledgement', firstCookie, { version: PRIVACY_NOTICE_VERSION })).status).toBe(204);
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE google_sub = $1`, [sub]);
    await enroll(rows[0]!.id);
    // session เดิม (ก่อนเปิด MFA) ต้องยืนยันด้วย
    expect((await protectedGet(firstCookie)).body.error?.code).toBe('MFA_REQUIRED');

    const again = await google.loginWith(app, { sub, email });
    const cookie = google.sessionCookieFrom(again.res)!.split(';')[0]!;
    expect((await me(cookie)).body.user.mfa).toMatchObject({ enabled: true, verified: false });
  });

  it('ยังไม่เปิด MFA → /auth/mfa/verify ตอบ 409 / ยังไม่ login → 401', async () => {
    const user = await createUser();
    const res = await post('/auth/mfa/verify', await loginAs(user.id), { code: '123456' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_NOT_ENABLED');
    expect((await request(app).post('/auth/mfa/verify').set('Origin', ORIGIN).send({ code: '123456' })).status).toBe(401);
  });
});

describe('role บังคับ MFA', () => {
  it('ยังไม่ตั้งค่า → MFA_ENROLLMENT_REQUIRED แต่เข้าหน้าตั้งค่าได้ / ตั้งค่าแล้วใช้ต่อได้ทันที / ปิดเองไม่ได้', async () => {
    await requireMfaForRoles(['super_admin']);
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const cookie = await loginAs(admin.id);

    const blocked = await protectedGet(cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await me(cookie)).body.user.mfa).toEqual({ enabled: false, required: true, verified: false });

    const status = await request(app).get('/me/mfa').set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.body.required).toBe(true);

    const secret = base32Decode((await post('/me/mfa/totp/setup', cookie)).body.secret);
    expect((await post('/me/mfa/totp/confirm', cookie, { code: codeFor(secret) })).status).toBe(200);
    expect((await protectedGet(cookie)).status).toBe(200);

    const disable = await request(app)
      .delete('/me/mfa')
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .send({ code: codeFor(secret, 1) });
    expect(disable.status).toBe(403);
    expect(disable.body.error.code).toBe('MFA_REQUIRED_BY_ROLE');
  });

  it('ผู้ใช้หลาย role: role ใดบังคับ = บังคับ / role ที่ไม่บังคับไม่กระทบ', async () => {
    await requireMfaForRoles(['admin']);
    const staff = await createUser({ roles: ['user', 'staff'] });
    expect((await protectedGet(await loginAs(staff.id))).status).toBe(200);
    const admin = await createUser({ roles: ['user', 'staff', 'admin'] });
    expect((await protectedGet(await loginAs(admin.id))).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('ต้องรับทราบประกาศความเป็นส่วนตัวก่อนตั้งค่า MFA (การตั้งค่าเก็บข้อมูลยืนยันตัวตนใหม่)', async () => {
    await requireMfaForRoles(['super_admin']);
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'], privacyAcknowledged: false });
    const cookie = await loginAs(admin.id);
    expect((await protectedGet(cookie)).body.error.code).toBe('PRIVACY_NOTICE_REQUIRED');
    expect((await post('/me/mfa/totp/setup', cookie)).body.error.code).toBe('PRIVACY_NOTICE_REQUIRED');
  });
});

describe('ยืนยันซ้ำ (step-up)', () => {
  it('รหัสถูก → นับเวลาใหม่ให้ session / รหัสผิด → 403', async () => {
    const user = await createUser();
    const { secret, cookie } = await enroll(user.id);
    await pool.query(`UPDATE sessions SET mfa_verified_at = now() - interval '1 hour' WHERE user_id = $1`, [user.id]);

    expect((await post('/auth/mfa/step-up', cookie, { code: '000000' })).status).toBe(403);
    expect((await post('/auth/mfa/step-up', cookie, { code: codeFor(secret, 1) })).status).toBe(204);
    const { rows } = await pool.query<{ recent: boolean }>(
      `SELECT mfa_verified_at > now() - interval '1 minute' AS recent FROM sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]!.recent).toBe(true);
  });
});
