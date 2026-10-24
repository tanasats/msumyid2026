import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { verifySigningPin } from '../src/services/signing-pin-service.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// PIN ลงนามเอกสาร: ตั้ง/เปลี่ยน (document:sign), hash ด้วย scrypt, ผิด 5 ครั้งล็อก 15 นาที

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function signer() {
  await createTestRole('test_sign', ['document:sign']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_sign'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const setPin = (cookie: string, body: object) =>
  request(app).put('/me/signing-pin').set('Cookie', cookie).set('Origin', ORIGIN).send(body);
const status = (cookie: string) => request(app).get('/me/signing-pin').set('Cookie', cookie);

/** ทำให้ session ทุกอันของผู้ใช้ดูเหมือน login มานานแล้ว (เกิน 10 นาที) */
const ageSessions = (userId: string) =>
  pool.query("UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1", [userId]);

describe('ตั้ง PIN', () => {
  it('ยังไม่ login → 401 / ไม่มี document:sign ตั้งไม่ได้ (403) แต่ดูสถานะได้ / ตั้งแล้ว hasPin = true และเก็บเฉพาะ hash', async () => {
    expect((await request(app).get('/me/signing-pin')).status).toBe(401);
    const none = await createUser();
    const noneCookie = await loginAs(none.id);
    expect((await status(noneCookie)).body).toEqual({ hasPin: false, lockedUntil: null });
    expect((await setPin(noneCookie, { newPin: '482915' })).status).toBe(403);

    const user = await signer();
    const res = await setPin(user.cookie, { newPin: '482915' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasPin: true, lockedUntil: null });
    const { rows } = await pool.query('SELECT pin_hash FROM signing_pins WHERE user_id = $1', [user.id]);
    expect(rows[0].pin_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(rows[0].pin_hash).not.toContain('482915');
  });

  it('รูปแบบผิด → 400 / เดาง่าย (เลขซ้ำ/เรียง) → 422', async () => {
    const user = await signer();
    for (const newPin of ['12345', '1234567890123', 'abcdef', '48 2915']) {
      expect((await setPin(user.cookie, { newPin })).status).toBe(400);
    }
    for (const newPin of ['000000', '123456', '987654', '345678']) {
      expect((await setPin(user.cookie, { newPin })).body.error.code).toBe('PIN_TOO_WEAK');
    }
  });

  it('เปลี่ยน PIN: ใส่ PIN เดิมถูก → ได้ / ผิด → 403 นับครั้ง / ไม่ใส่ PIN เดิม: เพิ่ง login → ได้, login นานแล้ว → 403 RECENT_LOGIN_REQUIRED', async () => {
    const user = await signer();
    await setPin(user.cookie, { newPin: '482915' });
    await ageSessions(user.id);

    expect((await setPin(user.cookie, { newPin: '739204' })).body.error.code).toBe('RECENT_LOGIN_REQUIRED');
    expect((await setPin(user.cookie, { currentPin: '111111', newPin: '739204' })).body.error.code).toBe('PIN_INCORRECT');
    expect((await setPin(user.cookie, { currentPin: '482915', newPin: '739204' })).status).toBe(200);
    await expect(verifySigningPin(user.id, '739204')).resolves.toBeUndefined();

    // ลืม PIN → login ใหม่ (session ใหม่) แล้วตั้งได้โดยไม่ต้องใช้ PIN เดิม
    const fresh = await loginAs(user.id);
    expect((await setPin(fresh, { newPin: '560317' })).status).toBe(200);
    await expect(verifySigningPin(user.id, '560317')).resolves.toBeUndefined();
  });
});

describe('ตรวจ PIN', () => {
  it('ยังไม่ตั้ง → PIN_NOT_SET / ถูก → ผ่านและล้างจำนวนครั้งที่ผิด', async () => {
    const user = await signer();
    await expect(verifySigningPin(user.id, '482915')).rejects.toMatchObject({ code: 'PIN_NOT_SET' });
    await setPin(user.cookie, { newPin: '482915' });
    await expect(verifySigningPin(user.id, '000001')).rejects.toMatchObject({ code: 'PIN_INCORRECT' });
    await verifySigningPin(user.id, '482915');
    const { rows } = await pool.query('SELECT failed_attempts FROM signing_pins WHERE user_id = $1', [user.id]);
    expect(rows[0].failed_attempts).toBe(0);
  });

  it('ผิดครบ 5 ครั้ง → ล็อก 15 นาที (PIN ถูกก็ใช้ไม่ได้ระหว่างล็อก) / หมดเวลาล็อกแล้วใช้ได้', async () => {
    const user = await signer();
    await setPin(user.cookie, { newPin: '482915' });
    for (let i = 0; i < 4; i++) {
      await expect(verifySigningPin(user.id, '000001')).rejects.toMatchObject({ code: 'PIN_INCORRECT' });
    }
    await expect(verifySigningPin(user.id, '000001')).rejects.toMatchObject({ code: 'PIN_LOCKED' });
    await expect(verifySigningPin(user.id, '482915')).rejects.toMatchObject({ code: 'PIN_LOCKED' });

    const locked = (await status(user.cookie)).body.lockedUntil;
    const minutes = (Date.parse(locked) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    await pool.query("UPDATE signing_pins SET locked_until = now() - interval '1 second' WHERE user_id = $1", [user.id]);
    await expect(verifySigningPin(user.id, '482915')).resolves.toBeUndefined();
  });

  it('ใส่ผิดพร้อมกันหลายคำขอ → นับครบทุกครั้ง (ล็อกแถว)', async () => {
    const user = await signer();
    await setPin(user.cookie, { newPin: '482915' });
    await Promise.allSettled([1, 2, 3].map(() => verifySigningPin(user.id, '000001')));
    const { rows } = await pool.query('SELECT failed_attempts FROM signing_pins WHERE user_id = $1', [user.id]);
    expect(rows[0].failed_attempts).toBe(3);
  });

  it('ลบบัญชี (PDPA) → ลบ PIN', async () => {
    const user = await signer();
    await setPin(user.cookie, { newPin: '482915' });
    const email = (await pool.query('SELECT email FROM users WHERE id = $1', [user.id])).rows[0].email;
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', await loginAs(admin.id))
      .set('Origin', ORIGIN)
      .send({ confirmEmail: email, reason: 'ขอลบข้อมูล' });
    const { rows } = await pool.query('SELECT 1 FROM signing_pins WHERE user_id = $1', [user.id]);
    expect(rows).toHaveLength(0);
  });
});
