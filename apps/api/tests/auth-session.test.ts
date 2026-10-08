import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import { PERMISSIONS } from '../src/services/permissions.js';

const app = createApp();
const WEB_ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('GET /auth/me', () => {
  it('ยังไม่ login → 401', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('session ถูกต้อง → ได้ข้อมูลผู้ใช้และ role', async () => {
    const user = await createUser({ email: 'somchai.s@msu.ac.th', roles: ['user', 'staff'] });
    const cookie = await loginAs(user.id);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: user.id,
      email: 'somchai.s@msu.ac.th',
      accountType: 'staff',
      approvalStatus: 'approved',
      roles: ['staff', 'user'],
      permissions: [],
    });
  });

  it('token ปลอม → 401 และลบ cookie ทิ้ง', async () => {
    const res = await request(app)
      .get('/auth/me')
      .set('Cookie', `${process.env.SESSION_COOKIE_NAME}=${'x'.repeat(43)}`);
    expect(res.status).toBe(401);
    expect(String(res.headers['set-cookie'])).toMatch(/msumyid_session=;.*HttpOnly.*SameSite=Lax/);
  });

  it('session หมดอายุ → 401', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('ผู้ใช้ถูกระงับ (is_active = false) → เข้าไม่ได้ทันที และ session ถูกเพิกถอนทั้งหมด', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    await loginAs(user.id); // session ที่สองบนอุปกรณ์อื่น
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1',
      [user.id],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('ผู้ใช้ถูกลบ (soft delete) → 401', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(401);
  });

  it('บัญชีรออนุมัติ → /auth/me ได้ (เพื่อแสดงหน้ารออนุมัติ) แต่ไม่มี permission', async () => {
    await createTestRole('test_approver', ['user:approve']);
    const user = await createUser({
      accountType: 'external',
      approvalStatus: 'pending',
      roles: ['user', 'test_approver'],
    });
    const cookie = await loginAs(user.id);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.approvalStatus).toBe('pending');
    expect(res.body.user.permissions).toEqual([]);
  });

  it('super_admin → permissions คือทุก permission ที่ลงทะเบียน', async () => {
    const user = await createUser({ roles: ['user', 'super_admin'] });
    const cookie = await loginAs(user.id);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    // ต้องตรงกับ permission ที่ประกาศในโค้ด (ตรวจว่า migration ลงทะเบียนครบด้วย)
    expect([...res.body.user.permissions].sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  it('ฐานข้อมูลเก็บเฉพาะ hash ของ token (ไม่มี token ดิบ)', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    const token = cookie.split('=')[1]!;

    const { rows } = await pool.query<{ hex: string }>(
      `SELECT encode(token_hash, 'hex') AS hex FROM sessions WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]!.hex).toHaveLength(64);
    expect(rows[0]!.hex).not.toContain(Buffer.from(token).toString('hex'));
  });
});

describe('POST /auth/logout', () => {
  it('ไม่มี Origin → 403 (CSRF)', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);

    const res = await request(app).post('/auth/logout').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('Origin จากเว็บอื่น → 403 (CSRF)', async () => {
    const res = await request(app).post('/auth/logout').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
  });

  it('ออกจากระบบ → ลบ session ในฐานข้อมูลและ cookie ใช้ต่อไม่ได้', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);

    const res = await request(app).post('/auth/logout').set('Origin', WEB_ORIGIN).set('Cookie', cookie);
    expect(res.status).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/msumyid_session=;/);

    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });

  it('ไม่มี session ก็ออกจากระบบได้ (204)', async () => {
    const res = await request(app).post('/auth/logout').set('Origin', WEB_ORIGIN);
    expect(res.status).toBe(204);
  });
});
