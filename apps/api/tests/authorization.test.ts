import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { loadSession, requireAuth, requirePermission } from '../src/middlewares/auth.js';
import { errorHandler } from '../src/middlewares/error-handler.js';
import { PERMISSIONS } from '../src/services/permissions.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// app ขนาดเล็กสำหรับทดสอบ middleware สิทธิ์ (ไม่เพิ่ม route ทดสอบเข้า app จริง)
const app = express();
app.use(cookieParser());
app.use(loadSession);
app.get('/logged-in', requireAuth, (_req, res) => {
  res.json({ ok: true });
});
app.get('/approve', requirePermission(PERMISSIONS.USER_APPROVE), (_req, res) => {
  res.json({ ok: true });
});
app.get('/assign', requirePermission(PERMISSIONS.USER_ROLE_ASSIGN), (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function statusOf(path: string, cookie?: string): Promise<number> {
  const req = request(app).get(path);
  if (cookie) req.set('Cookie', cookie);
  return (await req).status;
}

describe('requireAuth (ต้อง login เท่านั้น)', () => {
  it('ยังไม่ login → 401', async () => {
    expect(await statusOf('/logged-in')).toBe(401);
  });

  it('login แล้ว (role user อย่างเดียว) → 200', async () => {
    const user = await createUser();
    expect(await statusOf('/logged-in', await loginAs(user.id))).toBe(200);
  });

  it('บัญชีรออนุมัติ → 403 ACCOUNT_PENDING', async () => {
    const user = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    const res = await request(app).get('/logged-in').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_PENDING');
  });

  it('บัญชีถูกปฏิเสธ → 403 ACCOUNT_REJECTED', async () => {
    const user = await createUser({ accountType: 'external', approvalStatus: 'rejected' });
    const res = await request(app).get('/logged-in').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_REJECTED');
  });
});

describe('requirePermission', () => {
  it('ยังไม่ login → 401', async () => {
    expect(await statusOf('/approve')).toBe(401);
  });

  it('ไม่มี permission → 403 (ค่าเริ่มต้นคือปฏิเสธ)', async () => {
    const user = await createUser({ roles: ['user', 'staff', 'admin'] });
    const res = await request(app).get('/approve').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('มี permission จาก role → ผ่านเฉพาะ permission นั้น', async () => {
    await createTestRole('test_approver', [PERMISSIONS.USER_APPROVE]);
    const user = await createUser({ roles: ['user', 'test_approver'] });
    const cookie = await loginAs(user.id);

    expect(await statusOf('/approve', cookie)).toBe(200);
    expect(await statusOf('/assign', cookie)).toBe(403);
  });

  it('หลาย role → ได้ permission รวม (union) จากทุก role', async () => {
    await createTestRole('test_approver', [PERMISSIONS.USER_APPROVE]);
    await createTestRole('test_assigner', [PERMISSIONS.USER_ROLE_ASSIGN]);
    const user = await createUser({ roles: ['user', 'test_approver', 'test_assigner'] });
    const cookie = await loginAs(user.id);

    expect(await statusOf('/approve', cookie)).toBe(200);
    expect(await statusOf('/assign', cookie)).toBe(200);
  });

  it('หลาย role ที่มี permission ซ้ำกัน → ยังทำงานถูกต้อง', async () => {
    await createTestRole('test_a', [PERMISSIONS.USER_APPROVE]);
    await createTestRole('test_b', [PERMISSIONS.USER_APPROVE]);
    const user = await createUser({ roles: ['user', 'test_a', 'test_b'] });
    expect(await statusOf('/approve', await loginAs(user.id))).toBe(200);
  });

  it('super_admin → ผ่านทุก permission แม้ไม่มีการผูก permission ใดเลย', async () => {
    const user = await createUser({ roles: ['user', 'super_admin'] });
    const cookie = await loginAs(user.id);

    expect(await statusOf('/approve', cookie)).toBe(200);
    expect(await statusOf('/assign', cookie)).toBe(200);
  });

  it('บัญชีรออนุมัติที่ถือ role ที่มี permission → ยังไม่ได้สิทธิ์', async () => {
    await createTestRole('test_approver', [PERMISSIONS.USER_APPROVE]);
    const user = await createUser({
      accountType: 'external',
      approvalStatus: 'pending',
      roles: ['user', 'test_approver'],
    });
    const res = await request(app).get('/approve').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_PENDING');
  });

  it('ถอน role แล้ว → สิทธิ์หายทันทีใน request ถัดไป (ไม่ cache)', async () => {
    await createTestRole('test_approver', [PERMISSIONS.USER_APPROVE]);
    const user = await createUser({ roles: ['user', 'test_approver'] });
    const cookie = await loginAs(user.id);
    expect(await statusOf('/approve', cookie)).toBe(200);

    await pool.query(
      `DELETE FROM user_roles WHERE user_id = $1 AND role_id = (SELECT id FROM roles WHERE code = 'test_approver')`,
      [user.id],
    );
    expect(await statusOf('/approve', cookie)).toBe(403);
  });
});
