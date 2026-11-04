import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { verifyMfaCode } from '../src/services/mfa-service.js';
import { createUser, loginAs, queuedEmails, resetDatabase } from './helpers/db.js';
import { base32Decode, codeFor } from './helpers/mfa.js';

// MFA ของตัวเอง (docs/design/mfa.md): ตั้งค่า TOTP, รหัสกู้คืน, ผิด 5 ครั้งล็อก 15 นาที, ปิด — ฐานข้อมูลจริง app_test

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

/** แปลง base32 (secret ที่หน้าเว็บได้) กลับเป็นไบต์ — ทำหน้าที่แทนแอป Authenticator */

const post = (path: string, cookie: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
const status = (cookie: string) => request(app).get('/me/mfa').set('Cookie', cookie);

async function member() {
  const user = await createUser({ email: `mfa-${crypto.randomUUID().slice(0, 8)}@msu.ac.th` });
  return { ...user, cookie: await loginAs(user.id) };
}

/** ตั้งค่าและยืนยันจนเปิด MFA — คืน secret และรหัสกู้คืน */
async function enroll(cookie: string) {
  const setup = await post('/me/mfa/totp/setup', cookie);
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.secret);
  const firstCode = codeFor(secret);
  const confirm = await post('/me/mfa/totp/confirm', cookie, { code: firstCode });
  expect(confirm.status).toBe(200);
  return { secret, firstCode, recoveryCodes: confirm.body.recoveryCodes as string[] };
}

const auditActions = async (userId: string) =>
  (
    await pool.query<{ action: string }>(
      `SELECT action FROM user_audit_logs WHERE target_user_id = $1 ORDER BY created_at, id`,
      [userId],
    )
  ).rows.map((r) => r.action);

const inAppTemplates = async (userId: string) =>
  (await pool.query<{ template: string }>(`SELECT template FROM notifications WHERE user_id = $1 ORDER BY created_at, id`, [userId]))
    .rows.map((r) => r.template);

describe('ตั้งค่า MFA', () => {
  it('ยังไม่ login → 401 / เริ่มต้นยังไม่เปิด', async () => {
    expect((await request(app).get('/me/mfa')).status).toBe(401);
    const user = await member();
    const res = await status(user.cookie);
    expect(res.body).toEqual({ enabled: false, pending: false, recoveryCodesRemaining: 0, lockedUntil: null, required: false });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('เริ่มตั้งค่า → secret เก็บแบบเข้ารหัส / รหัสผิดยังไม่เปิด / รหัสถูก → เปิด + รหัสกู้คืน 10 รหัส + log + แจ้งเตือน', async () => {
    const user = await member();
    const setup = await post('/me/mfa/totp/setup', user.cookie);
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/MSU%20Digital%20ID:/);
    const secret = base32Decode(setup.body.secret);
    expect(secret.length).toBe(20);

    const { rows } = await pool.query<{ secret_ciphertext: Buffer; key_id: string }>(
      `SELECT secret_ciphertext, key_id FROM user_mfa_totp WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]!.key_id).toBe('test-1');
    expect(rows[0]!.secret_ciphertext.includes(secret)).toBe(false);
    expect((await status(user.cookie)).body).toMatchObject({ enabled: false, pending: true });

    const wrong = await post('/me/mfa/totp/confirm', user.cookie, { code: codeFor(secret, 5) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('MFA_CODE_INCORRECT');

    const ok = await post('/me/mfa/totp/confirm', user.cookie, { code: codeFor(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.recoveryCodes).size).toBe(10);
    for (const code of ok.body.recoveryCodes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

    expect((await status(user.cookie)).body).toMatchObject({ enabled: true, pending: false, recoveryCodesRemaining: 10 });
    expect(await auditActions(user.id)).toEqual(['mfa_enable']);
    expect(await inAppTemplates(user.id)).toEqual(['mfa_enabled']);
    expect((await queuedEmails(user.id)).map((e) => e.template)).toEqual(['mfa_enabled']);
  });

  it('เปิดอยู่แล้ว → เริ่มตั้งค่าใหม่/ยืนยันซ้ำไม่ได้ (409) และ secret เดิมยังใช้ได้', async () => {
    const user = await member();
    const { secret } = await enroll(user.cookie);
    const again = await post('/me/mfa/totp/setup', user.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MFA_ALREADY_ENABLED');
    expect((await post('/me/mfa/totp/confirm', user.cookie, { code: codeFor(secret, 1) })).status).toBe(409);
    await expect(verifyMfaCode(user.id, codeFor(secret, 1))).resolves.toBe('totp');
  });

  it('เริ่มตั้งค่าใหม่ก่อนยืนยันได้ (secret ใหม่ทับของเดิม)', async () => {
    const user = await member();
    const first = base32Decode((await post('/me/mfa/totp/setup', user.cookie)).body.secret);
    const second = base32Decode((await post('/me/mfa/totp/setup', user.cookie)).body.secret);
    expect(second.equals(first)).toBe(false);
    expect((await post('/me/mfa/totp/confirm', user.cookie, { code: codeFor(first) })).status).toBe(400);
    expect((await post('/me/mfa/totp/confirm', user.cookie, { code: codeFor(second) })).status).toBe(200);
  });

  it('ยืนยันโดยยังไม่เริ่มตั้งค่า → 409 / รูปแบบรหัสผิด → 400', async () => {
    const user = await member();
    const res = await post('/me/mfa/totp/confirm', user.cookie, { code: '123456' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_SETUP_NOT_STARTED');
    expect((await post('/me/mfa/totp/confirm', user.cookie, {})).status).toBe(400);
  });

  it('CSRF: Origin อื่นถูกปฏิเสธ', async () => {
    const user = await member();
    const res = await request(app).post('/me/mfa/totp/setup').set('Cookie', user.cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});

describe('ตรวจรหัส MFA', () => {
  it('รหัสเดิมใช้ซ้ำไม่ได้ (กันนำรหัสที่เห็นไปใช้)', async () => {
    const user = await member();
    const { secret, firstCode } = await enroll(user.cookie);
    // รหัสที่ใช้ไปตอนยืนยันแล้ว ใช้ซ้ำไม่ได้
    await expect(verifyMfaCode(user.id, firstCode)).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
    await expect(verifyMfaCode(user.id, codeFor(secret, 1))).resolves.toBe('totp');
    await expect(verifyMfaCode(user.id, codeFor(secret, 1))).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
  });

  it('ผิดครบ 5 ครั้ง → ล็อก 15 นาที (รหัสถูกก็ไม่ผ่าน) + แจ้งเตือน / ถูกก่อนครบ → ล้างจำนวนครั้ง', async () => {
    const user = await member();
    const { secret } = await enroll(user.cookie);

    for (let i = 0; i < 4; i++) await expect(verifyMfaCode(user.id, '000000')).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
    await expect(verifyMfaCode(user.id, codeFor(secret, 1))).resolves.toBe('totp');
    const { rows } = await pool.query<{ failed_attempts: number }>(`SELECT failed_attempts FROM user_mfa_totp WHERE user_id = $1`, [user.id]);
    expect(rows[0]!.failed_attempts).toBe(0);

    for (let i = 0; i < 4; i++) await expect(verifyMfaCode(user.id, '000000')).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
    await expect(verifyMfaCode(user.id, '000000')).rejects.toMatchObject({ status: 429, code: 'MFA_LOCKED' });
    // ล็อกแล้ว: รหัสถูก (ช่วงที่ยังไม่ใช้) ก็ไม่ผ่าน
    await pool.query(`UPDATE user_mfa_totp SET last_used_step = NULL WHERE user_id = $1`, [user.id]);
    await expect(verifyMfaCode(user.id, codeFor(secret))).rejects.toMatchObject({ code: 'MFA_LOCKED' });
    expect(await inAppTemplates(user.id)).toContain('mfa_locked');
    expect((await status(user.cookie)).body.lockedUntil).not.toBeNull();

    // หมดเวลาล็อก → ใช้ได้อีก
    await pool.query(`UPDATE user_mfa_totp SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [user.id]);
    await expect(verifyMfaCode(user.id, codeFor(secret))).resolves.toBe('totp');
  });

  it('ยังไม่เปิด MFA → MFA_NOT_ENABLED (รวมกรณีตั้งค่าค้างไว้)', async () => {
    const user = await member();
    await expect(verifyMfaCode(user.id, '123456')).rejects.toMatchObject({ code: 'MFA_NOT_ENABLED' });
    await post('/me/mfa/totp/setup', user.cookie);
    await expect(verifyMfaCode(user.id, '123456')).rejects.toMatchObject({ code: 'MFA_NOT_ENABLED' });
  });
});

describe('รหัสกู้คืน', () => {
  it('ใช้ได้รหัสละครั้ง ไม่สนตัวพิมพ์/ขีด + log + แจ้งเตือนจำนวนที่เหลือ / รหัสของคนอื่นใช้ไม่ได้', async () => {
    const user = await member();
    const other = await member();
    const { recoveryCodes } = await enroll(user.cookie);
    const { recoveryCodes: otherCodes } = await enroll(other.cookie);

    await expect(verifyMfaCode(user.id, recoveryCodes[0]!.toLowerCase().replaceAll('-', ' '))).resolves.toBe('recovery_code');
    await expect(verifyMfaCode(user.id, recoveryCodes[0]!)).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
    await expect(verifyMfaCode(user.id, otherCodes[0]!)).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });

    expect((await status(user.cookie)).body.recoveryCodesRemaining).toBe(9);
    expect(await auditActions(user.id)).toEqual(['mfa_enable', 'mfa_recovery_used']);
    const emails = await queuedEmails(user.id);
    expect(emails.at(-1)).toEqual({ template: 'mfa_recovery_code_used', params: { remaining: 9 } });
    // เก็บเฉพาะ hash
    const { rows } = await pool.query<{ code_hash: Buffer }>(`SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id = $1`, [user.id]);
    expect(rows.every((r) => !r.code_hash.toString('utf8').includes(recoveryCodes[1]!.slice(0, 4)))).toBe(true);
  });

  it('ออกชุดใหม่ต้องใส่รหัส / ชุดเดิมใช้ไม่ได้ทันที', async () => {
    const user = await member();
    const { secret, recoveryCodes } = await enroll(user.cookie);
    const denied = await post('/me/mfa/recovery-codes', user.cookie, { code: '000000' });
    expect(denied.status).toBe(403);

    const res = await post('/me/mfa/recovery-codes', user.cookie, { code: codeFor(secret, 1) });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    await expect(verifyMfaCode(user.id, recoveryCodes[0]!)).rejects.toMatchObject({ code: 'MFA_CODE_INCORRECT' });
    await expect(verifyMfaCode(user.id, res.body.recoveryCodes[0])).resolves.toBe('recovery_code');
    expect(await auditActions(user.id)).toContain('mfa_recovery_regenerate');
    expect(await inAppTemplates(user.id)).toContain('mfa_recovery_codes_regenerated');
  });
});

describe('ปิด MFA', () => {
  const disable = (cookie: string, body: object = {}) =>
    request(app).delete('/me/mfa').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

  it('ต้องใส่รหัส / รหัสถูก → ลบ secret และรหัสกู้คืน + log + แจ้งเตือน', async () => {
    const user = await member();
    const { secret } = await enroll(user.cookie);
    const noCode = await disable(user.cookie);
    expect(noCode.status).toBe(400);
    expect(noCode.body.error.code).toBe('MFA_CODE_REQUIRED');
    expect((await disable(user.cookie, { code: '000000' })).status).toBe(403);

    expect((await disable(user.cookie, { code: codeFor(secret, 1) })).status).toBe(204);
    expect((await status(user.cookie)).body).toMatchObject({ enabled: false, pending: false });
    const counts = await pool.query<{ totp: number; codes: number }>(
      `SELECT (SELECT count(*)::int FROM user_mfa_totp WHERE user_id = $1) AS totp,
              (SELECT count(*)::int FROM user_mfa_recovery_codes WHERE user_id = $1) AS codes`,
      [user.id],
    );
    expect(counts.rows[0]).toEqual({ totp: 0, codes: 0 });
    expect(await auditActions(user.id)).toEqual(['mfa_enable', 'mfa_disable']);
    expect(await inAppTemplates(user.id)).toEqual(['mfa_enabled', 'mfa_disabled']);
  });

  it('ยกเลิกการตั้งค่าที่ยังไม่ยืนยันได้โดยไม่ใส่รหัส และไม่เขียน log / ไม่มี MFA → 409', async () => {
    const user = await member();
    expect((await disable(user.cookie)).status).toBe(409);
    await post('/me/mfa/totp/setup', user.cookie);
    expect((await disable(user.cookie)).status).toBe(204);
    expect((await status(user.cookie)).body.pending).toBe(false);
    expect(await auditActions(user.id)).toEqual([]);
  });
});

describe('ลบบัญชี (PDPA)', () => {
  it('ลบ secret และรหัสกู้คืนของ MFA ด้วย', async () => {
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const user = await member();
    await enroll(user.cookie);
    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [user.id]);
    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', await loginAs(admin.id))
      .set('Origin', ORIGIN)
      .send({ confirmEmail: rows[0]!.email, reason: 'ทดสอบ' });
    expect(res.status).toBe(204);
    const counts = await pool.query<{ totp: number; codes: number }>(
      `SELECT (SELECT count(*)::int FROM user_mfa_totp WHERE user_id = $1) AS totp,
              (SELECT count(*)::int FROM user_mfa_recovery_codes WHERE user_id = $1) AS codes`,
      [user.id],
    );
    expect(counts.rows[0]).toEqual({ totp: 0, codes: 0 });
  });
});
