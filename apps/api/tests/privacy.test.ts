import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { findSessionUser } from '../src/repositories/session-repository.js';
import { PRIVACY_NOTICE_VERSION } from '../src/services/privacy-service.js';
import { hashSessionToken, purgeExpiredSessions } from '../src/services/session-service.js';
import { createUser, loginAs, resetDatabase } from './helpers/db.js';

// PDPA (docs/design/pdpa.md): ทุกคนต้องรับทราบประกาศความเป็นส่วนตัวเวอร์ชันปัจจุบันก่อนใช้ระบบ (ตรวจที่ requireAuth)
// และ session ที่หมดอายุถูกลบออกจากฐานข้อมูล

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

const acknowledge = (cookie: string, version: unknown) =>
  request(app).post('/me/privacy-acknowledgement').set('Cookie', cookie).set('Origin', ORIGIN).send({ version });
const me = (cookie: string) => request(app).get('/auth/me').set('Cookie', cookie);
const staffProfile = (cookie: string) => request(app).get('/me/staff-profile').set('Cookie', cookie);
const acknowledgements = async (userId: string) =>
  (await pool.query('SELECT notice_version FROM privacy_acknowledgements WHERE user_id = $1', [userId])).rows;

describe('การรับทราบประกาศความเป็นส่วนตัว', () => {
  it('ยังไม่รับทราบ → /auth/me ใช้ได้ (privacyAcknowledged = false) แต่ endpoint ที่ต้อง login/มี permission ตอบ 403 PRIVACY_NOTICE_REQUIRED', async () => {
    const user = await createUser({ privacyAcknowledged: false });
    const cookie = await loginAs(user.id);
    const res = await me(cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.privacyAcknowledged).toBe(false);
    expect((await staffProfile(cookie)).body.error.code).toBe('PRIVACY_NOTICE_REQUIRED');

    // super_admin ก็ต้องรับทราบ (ไม่ใช่สิทธิ์ จึงไม่มีข้อยกเว้น)
    const admin = await createUser({ roles: ['user', 'super_admin'], privacyAcknowledged: false });
    const adminRes = await request(app).get('/admin/users').set('Cookie', await loginAs(admin.id));
    expect(adminRes.status).toBe(403);
    expect(adminRes.body.error.code).toBe('PRIVACY_NOTICE_REQUIRED');
  });

  it('รับทราบเวอร์ชันปัจจุบัน → ใช้งานได้ทันที / กดซ้ำไม่เกิดแถวใหม่ / เวอร์ชันเก่าหรือค่าผิด → ปฏิเสธ', async () => {
    const user = await createUser({ privacyAcknowledged: false });
    const cookie = await loginAs(user.id);

    expect((await acknowledge(cookie, PRIVACY_NOTICE_VERSION + 1)).body.error.code).toBe('PRIVACY_NOTICE_OUTDATED');
    expect((await acknowledge(cookie, 'x')).status).toBe(400);
    expect(await acknowledgements(user.id)).toHaveLength(0);

    expect((await acknowledge(cookie, PRIVACY_NOTICE_VERSION)).status).toBe(204);
    expect((await acknowledge(cookie, PRIVACY_NOTICE_VERSION)).status).toBe(204);
    expect(await acknowledgements(user.id)).toEqual([{ notice_version: PRIVACY_NOTICE_VERSION }]);
    expect((await me(cookie)).body.user.privacyAcknowledged).toBe(true);
    expect((await staffProfile(cookie)).status).toBe(200);
  });

  it('บัญชีรออนุมัติรับทราบได้ (แล้วจึงเห็นสถานะรออนุมัติ) / ยังไม่ login → 401 / ไม่มี Origin → CSRF ปฏิเสธ', async () => {
    const pending = await createUser({ accountType: 'external', approvalStatus: 'pending', privacyAcknowledged: false });
    const cookie = await loginAs(pending.id);
    expect((await staffProfile(cookie)).body.error.code).toBe('PRIVACY_NOTICE_REQUIRED');
    expect((await acknowledge(cookie, PRIVACY_NOTICE_VERSION)).status).toBe(204);
    expect((await staffProfile(cookie)).body.error.code).toBe('ACCOUNT_PENDING');

    const anonymous = await request(app).post('/me/privacy-acknowledgement').set('Origin', ORIGIN).send({ version: 1 });
    expect(anonymous.status).toBe(401);
    const noOrigin = await request(app).post('/me/privacy-acknowledgement').set('Cookie', cookie).send({ version: 1 });
    expect(noOrigin.status).toBe(403);
  });

  it('ประกาศเปลี่ยนเวอร์ชัน → ผู้ที่รับทราบฉบับเดิมต้องรับทราบใหม่', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    const token = cookie.split('=')[1]!;
    expect((await findSessionUser(pool, hashSessionToken(token), PRIVACY_NOTICE_VERSION))!.privacyAcknowledged).toBe(true);
    expect((await findSessionUser(pool, hashSessionToken(token), PRIVACY_NOTICE_VERSION + 1))!.privacyAcknowledged).toBe(false);
  });
});

describe('ลบ session ที่หมดอายุ', () => {
  it('ลบเฉพาะ session ที่หมดอายุ session ที่ยังใช้ได้คงอยู่', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    await loginAs(user.id);
    await loginAs(user.id);
    // ทำให้ 2 ใน 3 session หมดอายุ (เว้นอันที่ cookie ชี้)
    await pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
       WHERE user_id = $1 AND token_hash <> $2`,
      [user.id, hashSessionToken(cookie.split('=')[1]!)],
    );
    expect(await purgeExpiredSessions()).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [user.id])).rows[0].n).toBe(1);
    expect((await me(cookie)).status).toBe(200);
  });
});
