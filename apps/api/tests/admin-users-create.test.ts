import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// ลงทะเบียนผู้ใช้ล่วงหน้า + ผูกบัญชี Google ตอน login ครั้งแรก (ระยะ 4)
// mock เฉพาะการเรียก Google ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

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

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

function preRegister(cookie: string, body: object) {
  return request(app).post('/admin/users').set('Cookie', cookie).set('Origin', ORIGIN).send(body);
}

async function usersByEmail(email: string) {
  const { rows } = await pool.query(
    `SELECT id, google_sub, name, display_name, account_type, approval_status
     FROM users WHERE lower(email) = lower($1) ORDER BY created_at`,
    [email],
  );
  return rows;
}

async function rolesOf(userId: string) {
  const { rows } = await pool.query<{ code: string }>(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  );
  return rows.map((r) => r.code);
}

async function auditActions(userId: string) {
  const { rows } = await pool.query(
    `SELECT action, actor_id FROM user_audit_logs WHERE target_user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows;
}

describe('POST /admin/users (ลงทะเบียนล่วงหน้า)', () => {
  it('สร้างบัญชีที่อนุมัติแล้ว ยังไม่ผูก Google พร้อม role ประเภทบัญชีและ log', async () => {
    const admin = await superAdmin();
    const res = await preRegister(admin.cookie, {
      email: 'Guest.Lecturer@gmail.com',
      name: 'อาจารย์พิเศษ',
      accountType: 'external',
      reason: 'อาจารย์พิเศษภาคเรียนที่ 2',
    });
    expect(res.status).toBe(201);

    const [user] = await usersByEmail('guest.lecturer@gmail.com');
    expect(user).toMatchObject({
      id: res.body.id,
      google_sub: null,
      display_name: 'อาจารย์พิเศษ',
      account_type: 'external',
      approval_status: 'approved',
    });
    expect(await rolesOf(res.body.id)).toEqual(['external', 'user']);
    expect(await auditActions(res.body.id)).toEqual([{ action: 'create', actor_id: admin.id }]);

    const detail = await request(app).get(`/admin/users/${res.body.id}`).set('Cookie', admin.cookie);
    expect(detail.body.user.hasGoogleAccount).toBe(false);
  });

  it('อีเมลซ้ำ (ไม่สนตัวพิมพ์) กับบัญชีที่ลงทะเบียนไว้หรือผู้ใช้ Google เดิม → 409', async () => {
    const admin = await superAdmin();
    await preRegister(admin.cookie, { email: 'dup@gmail.com', name: 'ก', accountType: 'external' });
    const again = await preRegister(admin.cookie, { email: 'DUP@gmail.com', name: 'ข', accountType: 'external' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EMAIL_EXISTS');

    await createUser({ email: 'existing@msu.ac.th' });
    const existing = await preRegister(admin.cookie, { email: 'existing@msu.ac.th', name: 'ค', accountType: 'staff' });
    expect(existing.body.error.code).toBe('EMAIL_EXISTS');
  });

  it('ข้อมูลไม่ถูกต้อง → 400, บุคลากรกำหนดหน่วยงานเองไม่ได้ → 409', async () => {
    const admin = await superAdmin();
    expect((await preRegister(admin.cookie, { email: 'not-email', name: 'ก', accountType: 'staff' })).status).toBe(400);
    expect((await preRegister(admin.cookie, { email: 'a@msu.ac.th', name: '', accountType: 'staff' })).status).toBe(400);

    const { rows } = await pool.query(`SELECT id FROM org_units WHERE code = '25'`);
    const res = await preRegister(admin.cookie, {
      email: 'a@msu.ac.th',
      name: 'ก',
      accountType: 'staff',
      orgUnitId: rows[0].id,
    });
    expect(res.body.error.code).toBe('ORG_UNIT_FROM_ERP');
  });

  it('ต้องมี user:create', async () => {
    await createTestRole('test_reader', ['user:read']);
    const reader = await createUser({ roles: ['user', 'test_reader'] });
    const res = await preRegister(await loginAs(reader.id), { email: 'x@gmail.com', name: 'ก', accountType: 'external' });
    expect(res.status).toBe(403);
  });
});

describe('ผูกบัญชีที่ลงทะเบียนล่วงหน้าตอน login ด้วย Google', () => {
  it('บุคลากรภายนอก: ผูกกับแถวเดิม ใช้งานได้ทันทีโดยไม่ต้องรออนุมัติ และใช้ชื่อจาก Google', async () => {
    const admin = await superAdmin();
    const { body } = await preRegister(admin.cookie, { email: 'guest@gmail.com', name: 'ชื่อชั่วคราว', accountType: 'external' });

    const { res } = await google.loginWith(app, { email: 'Guest@gmail.com', hd: null, name: 'Guest Lecturer' });
    expect(res.headers.location).toBe('http://localhost:3010');

    const users = await usersByEmail('guest@gmail.com');
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: body.id,
      name: 'Guest Lecturer',
      display_name: 'Guest Lecturer',
      account_type: 'external',
      approval_status: 'approved',
    });
    expect(users[0].google_sub).not.toBeNull();
    expect(await rolesOf(body.id)).toEqual(['external', 'user']);
    expect(await auditActions(body.id)).toEqual([
      { action: 'create', actor_id: admin.id },
      { action: 'link_google', actor_id: null },
    ]);

    const cookie = google.sessionCookieFrom(res)!.split(';')[0]!;
    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.body.user).toMatchObject({ id: body.id, approvalStatus: 'approved' });
  });

  it('login ครั้งถัดไปใช้ google_sub ตามปกติ ไม่ผูกซ้ำ', async () => {
    const admin = await superAdmin();
    const { body } = await preRegister(admin.cookie, { email: 'staff1@msu.ac.th', name: 'ก', accountType: 'staff' });
    const sub = 'google-staff1';
    await google.loginWith(app, { sub, email: 'staff1@msu.ac.th' });
    await google.loginWith(app, { sub, email: 'staff1@msu.ac.th' });

    expect(await usersByEmail('staff1@msu.ac.th')).toHaveLength(1);
    expect((await auditActions(body.id)).filter((l) => l.action === 'link_google')).toHaveLength(1);
  });

  it('อีเมลโดเมน มมส. แต่เป็นบัญชี Google ส่วนตัว (ไม่มี hd) → ไม่ผูก ได้บัญชีใหม่ที่รออนุมัติ', async () => {
    const admin = await superAdmin();
    const { body } = await preRegister(admin.cookie, { email: 'boss@msu.ac.th', name: 'ผู้บริหาร', accountType: 'staff' });

    await google.loginWith(app, { email: 'boss@msu.ac.th', hd: null });

    const users = await usersByEmail('boss@msu.ac.th');
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({ id: body.id, google_sub: null });
    expect(users[1]).toMatchObject({ account_type: 'external', approval_status: 'pending' });
  });

  it('บัญชีที่ลงทะเบียนไว้แต่ถูกปิด → ผูกแล้วแต่เข้าระบบไม่ได้', async () => {
    const admin = await superAdmin();
    const { body } = await preRegister(admin.cookie, { email: 'off@gmail.com', name: 'ก', accountType: 'external' });
    await request(app)
      .post(`/admin/users/${body.id}/deactivate`)
      .set('Cookie', admin.cookie)
      .set('Origin', ORIGIN)
      .send({ reason: 'ยกเลิก' });

    const { res } = await google.loginWith(app, { email: 'off@gmail.com', hd: null });
    expect(res.headers.location).toBe('http://localhost:3010/login?error=ACCOUNT_DISABLED');
    expect(google.sessionCookieFrom(res)).toBeUndefined();
  });
});
