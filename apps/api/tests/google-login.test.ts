import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { googleOAuth } from '../src/services/google-oauth.js';
import { classifyAccount } from '../src/services/google-login-service.js';
import { resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// mock เฉพาะการเรียก Google (แลก code + ตรวจ ID token) ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const WEB_URL = 'http://localhost:3010';
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME!;

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

async function userRoles(email: string): Promise<string[]> {
  const { rows } = await pool.query<{ code: string }>(
    `SELECT r.code FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE u.email = $1 ORDER BY r.code`,
    [email],
  );
  return rows.map((r) => r.code);
}

describe('classifyAccount', () => {
  const domains = ['msu.ac.th'];

  it('ตัวเลข 11 หลัก + โดเมน มมส. + hd ตรง = นิสิต พร้อมรหัสคณะหลักที่ 5-6', () => {
    expect(classifyAccount('64011212345@msu.ac.th', 'msu.ac.th', domains)).toEqual({
      accountType: 'student',
      facultyCode: '12',
    });
  });

  it('บัญชี มมส. อื่น ๆ = บุคลากร', () => {
    expect(classifyAccount('somchai.s@msu.ac.th', 'msu.ac.th', domains)).toEqual({ accountType: 'staff' });
    // ตัวเลขไม่ครบ 11 หลัก ไม่ใช่นิสิต
    expect(classifyAccount('6401121234@msu.ac.th', 'msu.ac.th', domains)).toEqual({ accountType: 'staff' });
    expect(classifyAccount('640112123456@msu.ac.th', 'msu.ac.th', domains)).toEqual({ accountType: 'staff' });
  });

  it('โดเมนไม่สนตัวพิมพ์เล็ก/ใหญ่', () => {
    expect(classifyAccount('Somchai.S@MSU.AC.TH', 'msu.ac.th', domains)).toEqual({ accountType: 'staff' });
  });

  it('Gmail / โดเมนอื่น = บุคลากรภายนอก', () => {
    expect(classifyAccount('someone@gmail.com', null, domains)).toEqual({ accountType: 'external' });
    expect(classifyAccount('someone@other.ac.th', 'other.ac.th', domains)).toEqual({ accountType: 'external' });
  });

  it('email โดเมน มมส. แต่ไม่มี hd หรือ hd ไม่ตรง = บุคลากรภายนอก', () => {
    expect(classifyAccount('64011212345@msu.ac.th', null, domains)).toEqual({ accountType: 'external' });
    expect(classifyAccount('somchai.s@msu.ac.th', 'evil.com', domains)).toEqual({ accountType: 'external' });
  });
});

describe('GET /auth/google', () => {
  it('redirect ไป Google พร้อม PKCE S256, state, nonce และ scope ที่ถูกต้อง', async () => {
    const { res, location, state, nonce } = await google.startLogin(app);

    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('client_id')).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(process.env.GOOGLE_REDIRECT_URI);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('openid email profile');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('เก็บ state/nonce/verifier ใน cookie httpOnly อายุสั้นที่ path /auth/google', async () => {
    const { res } = await google.startLogin(app);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`${SESSION_COOKIE}_oauth=`));
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/Path=\/auth\/google/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('สร้าง state ใหม่ทุกครั้ง', async () => {
    const a = await google.startLogin(app);
    const b = await google.startLogin(app);
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('GET /auth/google/callback — ตรวจความถูกต้อง', () => {
  it('ส่ง code verifier จาก cookie ไปแลก code', async () => {
    const { exchange } = await google.loginWith(app);
    expect(exchange).toHaveBeenCalledOnce();
    const [code, verifier] = exchange.mock.calls[0]!;
    expect(code).toBe('auth-code');
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('ผู้ใช้กดยกเลิกที่ Google → กลับหน้า login พร้อม GOOGLE_DENIED', async () => {
    const start = await google.startLogin(app);
    const exchange = vi.spyOn(googleOAuth, 'exchangeCode');
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ error: 'access_denied', state: start.state })
      .set('Cookie', start.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=GOOGLE_DENIED`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('ไม่มี cookie (เช่น cookie หมดอายุ / ถูกโจมตี CSRF) → INVALID_STATE', async () => {
    const start = await google.startLogin(app);
    const exchange = vi.spyOn(googleOAuth, 'exchangeCode');
    const res = await request(app).get('/auth/google/callback').query({ code: 'x', state: start.state });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=INVALID_STATE`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('state ไม่ตรงกับ cookie → INVALID_STATE', async () => {
    const start = await google.startLogin(app);
    const exchange = vi.spyOn(googleOAuth, 'exchangeCode');
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ code: 'x', state: 'x'.repeat(43) })
      .set('Cookie', start.cookie);
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=INVALID_STATE`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('ไม่มี code → INVALID_STATE', async () => {
    const start = await google.startLogin(app);
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ state: start.state })
      .set('Cookie', start.cookie);
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=INVALID_STATE`);
  });

  it('ลบ cookie oauth ทิ้งหลัง callback เสมอ (ใช้ state ซ้ำไม่ได้)', async () => {
    const { res } = await google.loginWith(app);
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`${SESSION_COOKIE}_oauth=;.*Path=/auth/google`));
  });

  it('แลก code หรือตรวจ ID token ไม่ผ่าน → LOGIN_FAILED', async () => {
    const start = await google.startLogin(app);
    vi.spyOn(googleOAuth, 'exchangeCode').mockRejectedValue(new Error('invalid_grant'));
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ code: 'x', state: start.state })
      .set('Cookie', start.cookie);
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=LOGIN_FAILED`);
  });

  it('nonce ใน ID token ไม่ตรง → LOGIN_FAILED และไม่สร้างผู้ใช้', async () => {
    const { res } = await google.loginWith(app, { nonce: 'y'.repeat(43) });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=LOGIN_FAILED`);
    const { rows } = await pool.query('SELECT 1 FROM users');
    expect(rows).toHaveLength(0);
  });

  it('ID token ไม่มี nonce → LOGIN_FAILED', async () => {
    const start = await google.startLogin(app);
    vi.spyOn(googleOAuth, 'exchangeCode').mockResolvedValue(google.identity({ nonce: null }));
    const res = await request(app)
      .get('/auth/google/callback')
      .query({ code: 'x', state: start.state })
      .set('Cookie', start.cookie);
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=LOGIN_FAILED`);
  });

  it('email_verified = false → EMAIL_NOT_VERIFIED และไม่สร้างผู้ใช้', async () => {
    const { res } = await google.loginWith(app, { emailVerified: false });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=EMAIL_NOT_VERIFIED`);
    expect(google.sessionCookieFrom(res)).toBeUndefined();
    const { rows } = await pool.query('SELECT 1 FROM users');
    expect(rows).toHaveLength(0);
  });
});

describe('GET /auth/google/callback — สร้างผู้ใช้และให้ role', () => {
  it('นิสิต: สร้างผู้ใช้ ผูกคณะจากหลักที่ 5-6 ได้ role user + student และเขียน log', async () => {
    const { res } = await google.loginWith(app, { email: '64011212345@msu.ac.th', name: 'นิสิต ทดสอบ' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(WEB_URL);
    expect(google.sessionCookieFrom(res)).toMatch(/HttpOnly/);

    const { rows } = await pool.query(
      `SELECT u.account_type, u.approval_status, u.name, u.last_login_at IS NOT NULL AS logged_in, o.code AS org_code
       FROM users u LEFT JOIN org_units o ON o.id = u.org_unit_id
       WHERE u.email = '64011212345@msu.ac.th'`,
    );
    expect(rows[0]).toEqual({
      account_type: 'student',
      approval_status: 'approved',
      name: 'นิสิต ทดสอบ',
      logged_in: true,
      org_code: '12',
    });
    expect(await userRoles('64011212345@msu.ac.th')).toEqual(['student', 'user']);

    const logs = await pool.query(
      `SELECT l.actor_id, l.action, r.code FROM role_change_logs l JOIN roles r ON r.id = l.role_id ORDER BY r.code`,
    );
    expect(logs.rows).toEqual([
      { actor_id: null, action: 'grant', code: 'student' },
      { actor_id: null, action: 'grant', code: 'user' },
    ]);
  });

  it('นิสิตที่รหัสคณะไม่มีใน org_units → org_unit_id = NULL แต่ยัง login ได้', async () => {
    const { res } = await google.loginWith(app, { email: '64019912345@msu.ac.th' });
    expect(res.headers.location).toBe(WEB_URL);
    const { rows } = await pool.query(`SELECT org_unit_id FROM users WHERE email = '64019912345@msu.ac.th'`);
    expect(rows[0]!.org_unit_id).toBeNull();
  });

  it('บุคลากร: ได้ role user + staff และ approved ทันที', async () => {
    const { res } = await google.loginWith(app, { email: 'somchai.s@msu.ac.th' });
    expect(res.headers.location).toBe(WEB_URL);
    expect(await userRoles('somchai.s@msu.ac.th')).toEqual(['staff', 'user']);

    const me = await request(app).get('/auth/me').set('Cookie', google.sessionCookieFrom(res)!.split(';')[0]!);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ accountType: 'staff', approvalStatus: 'approved', roles: ['staff', 'user'] });
  });

  it('บุคลากรภายนอก (Gmail): สร้างบัญชีรออนุมัติ ได้แค่ role user และ /auth/me แสดงสถานะรออนุมัติ', async () => {
    const { res } = await google.loginWith(app, { email: 'someone@gmail.com', hd: null });
    expect(res.headers.location).toBe(WEB_URL);
    expect(await userRoles('someone@gmail.com')).toEqual(['user']);

    const me = await request(app).get('/auth/me').set('Cookie', google.sessionCookieFrom(res)!.split(';')[0]!);
    expect(me.body.user).toMatchObject({
      accountType: 'external',
      approvalStatus: 'pending',
      roles: ['user'],
      permissions: [],
    });
  });

  it('email @msu.ac.th แต่ไม่มี hd → ถือเป็นบุคลากรภายนอก รออนุมัติ', async () => {
    await google.loginWith(app, { email: 'somchai.s@msu.ac.th', hd: null });
    const { rows } = await pool.query(`SELECT account_type, approval_status FROM users`);
    expect(rows[0]).toEqual({ account_type: 'external', approval_status: 'pending' });
    expect(await userRoles('somchai.s@msu.ac.th')).toEqual(['user']);
  });

  it('login ซ้ำ: ค้นด้วย google_sub อัปเดตโปรไฟล์ ไม่สร้างผู้ใช้/role/log ซ้ำ', async () => {
    const sub = 'google-same-sub';
    await google.loginWith(app, { sub, email: 'somchai.s@msu.ac.th', name: 'ชื่อเดิม' });
    // email เปลี่ยนได้ แต่ยังเป็นผู้ใช้คนเดิมเพราะใช้ google_sub
    const { res } = await google.loginWith(app, { sub, email: 'somchai.new@msu.ac.th', name: 'ชื่อใหม่' });
    expect(res.headers.location).toBe(WEB_URL);

    const users = await pool.query(`SELECT email, name FROM users`);
    expect(users.rows).toEqual([{ email: 'somchai.new@msu.ac.th', name: 'ชื่อใหม่' }]);
    const logs = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM role_change_logs`);
    expect(logs.rows[0]!.n).toBe(2);
    const sessions = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions`);
    expect(sessions.rows[0]!.n).toBe(2);
  });

  it('ให้ role ประเภทบัญชีที่หายไปคืนตอน login (ตรวจทุกครั้งที่ login)', async () => {
    const sub = 'google-regrant';
    await google.loginWith(app, { sub, email: 'somchai.s@msu.ac.th' });
    await pool.query(
      `DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE code = 'staff')`,
    );
    await google.loginWith(app, { sub, email: 'somchai.s@msu.ac.th' });
    expect(await userRoles('somchai.s@msu.ac.th')).toEqual(['staff', 'user']);
  });

  it('ไม่เปลี่ยนประเภทบัญชีหรือสถานะอนุมัติของผู้ใช้เดิม แม้ email จะเปลี่ยนประเภท', async () => {
    const sub = 'google-type-change';
    await google.loginWith(app, { sub, email: 'someone@gmail.com', hd: null });
    await google.loginWith(app, { sub, email: 'somchai.s@msu.ac.th', hd: 'msu.ac.th' });
    const { rows } = await pool.query(`SELECT account_type, approval_status FROM users`);
    expect(rows[0]).toEqual({ account_type: 'external', approval_status: 'pending' });
    expect(await userRoles('somchai.s@msu.ac.th')).toEqual(['user']);
  });

  it('ผู้ใช้ที่ถูกระงับ → ACCOUNT_DISABLED และไม่สร้าง session', async () => {
    const sub = 'google-disabled';
    await google.loginWith(app, { sub });
    await pool.query(`UPDATE users SET is_active = false`);
    await pool.query(`DELETE FROM sessions`);

    const { res } = await google.loginWith(app, { sub, name: 'ชื่อใหม่' });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=ACCOUNT_DISABLED`);
    expect(google.sessionCookieFrom(res)).toBeUndefined();
    const sessions = await pool.query(`SELECT 1 FROM sessions`);
    expect(sessions.rows).toHaveLength(0);
    // ไม่ถูกอัปเดตข้อมูล
    const { rows } = await pool.query(`SELECT name FROM users`);
    expect(rows[0]!.name).toBe('สมชาย ใจดี');
  });

  it('ผู้ใช้ที่ถูกลบ (soft delete) → ACCOUNT_DISABLED', async () => {
    const sub = 'google-deleted';
    await google.loginWith(app, { sub });
    await pool.query(`UPDATE users SET deleted_at = now()`);
    const { res } = await google.loginWith(app, { sub });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=ACCOUNT_DISABLED`);
  });

  it('Google ไม่ส่งชื่อมา → ใช้ email เป็นชื่อ', async () => {
    await google.loginWith(app, { email: 'noname@msu.ac.th', name: null });
    const { rows } = await pool.query(`SELECT name FROM users`);
    expect(rows[0]!.name).toBe('noname@msu.ac.th');
  });
});
