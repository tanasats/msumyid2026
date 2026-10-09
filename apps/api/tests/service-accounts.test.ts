import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { expireAccounts } from '../src/services/account-expiry-service.js';
import { erpHr } from '../src/services/erp-hr.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// บัญชีหน่วยงาน (account_type = 'service'): จัดประเภทตอน login, อนุมัติ, แก้ไข, ลงทะเบียนล่วงหน้า และหมดอายุ
// mock เฉพาะ Google และ ERP-HR ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const WEB_URL = 'http://localhost:3010';
const ACCESS_TOKEN = 'ya29.test-access-token';
const HOUR = 60 * 60 * 1000;

let orgUnitId: string;

beforeEach(async () => {
  await resetDatabase();
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM org_units WHERE is_active ORDER BY code LIMIT 1`);
  orgUnitId = rows[0]!.id;
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

/** บุคลากรที่ใช้งานได้ — ใช้เป็นผู้รับผิดชอบ */
function staffMember() {
  return createUser({ accountType: 'staff', roles: ['user', 'staff'] });
}

function pendingService(input: { orgUnitId?: string | null; responsibleUserId?: string | null } = {}) {
  return createUser({ accountType: 'service', approvalStatus: 'pending', roles: ['user'], ...input });
}

const post = (path: string, cookie: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
const patch = (path: string, cookie: string, body: object) =>
  request(app).patch(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

async function rolesOf(userId: string) {
  const { rows } = await pool.query<{ code: string }>(
    `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  );
  return rows.map((r) => r.code);
}

async function userRow(userId: string) {
  const { rows } = await pool.query(
    `SELECT account_type, approval_status, is_active, org_unit_id, responsible_user_id, account_expires_at,
            deactivated_by, deactivated_at IS NOT NULL AS deactivated
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0];
}

/** login บัญชี มมส. ที่ไม่ใช่นิสิต โดย ERP ตอบตามที่กำหนด (null = ไม่พบบุคลากร, Error = เรียกไม่สำเร็จ) */
async function loginMsu(erp: null | Error, overrides: Parameters<typeof google.identity>[0] = {}) {
  const fetchStaffInfo = vi.spyOn(erpHr, 'fetchStaffInfo');
  if (erp instanceof Error) fetchStaffInfo.mockRejectedValue(erp);
  else fetchStaffInfo.mockResolvedValue(erp);
  return google.loginWith(app, { email: 'openhouse2026@msu.ac.th', accessToken: ACCESS_TOKEN, ...overrides });
}

async function userIdByEmail(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return rows[0]!.id;
}

describe('login: จัดประเภทบัญชีหน่วยงาน', () => {
  it('บัญชีใหม่ที่ ERP ยืนยันว่าไม่พบบุคลากร → บัญชีหน่วยงาน รออนุมัติ ได้แค่ role user', async () => {
    const { res } = await loginMsu(null);
    expect(res.headers.location).toBe(WEB_URL);
    const id = await userIdByEmail('openhouse2026@msu.ac.th');
    expect(await userRow(id)).toMatchObject({ account_type: 'service', approval_status: 'pending' });
    expect(await rolesOf(id)).toEqual(['user']);

    const me = await request(app).get('/auth/me').set('Cookie', google.sessionCookieFrom(res)!.split(';')[0]!);
    expect(me.body.user).toMatchObject({ accountType: 'service', approvalStatus: 'pending', permissions: [] });
  });

  it('ERP เรียกไม่สำเร็จ → ยังเป็นบุคลากร (ERP ล่มต้องไม่ทำให้บุคลากรเสียสิทธิ์)', async () => {
    await loginMsu(new Error('timeout'));
    const id = await userIdByEmail('openhouse2026@msu.ac.th');
    expect(await userRow(id)).toMatchObject({ account_type: 'staff', approval_status: 'approved' });
    expect(await rolesOf(id)).toEqual(['staff', 'user']);
  });

  it('บุคลากรเดิมที่ ERP ไม่พบข้อมูลภายหลัง → ไม่ถูกเปลี่ยนเป็นบัญชีหน่วยงาน', async () => {
    const sub = 'google-existing-staff';
    await loginMsu(new Error('timeout'), { sub });
    await loginMsu(null, { sub });
    const id = await userIdByEmail('openhouse2026@msu.ac.th');
    expect(await userRow(id)).toMatchObject({ account_type: 'staff', approval_status: 'approved' });
  });

  it('บัญชีหน่วยงานที่ลงทะเบียนล่วงหน้า → ผูก Google แล้วใช้งานได้ทันที คงประเภทบัญชี', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const created = await post('/admin/users', admin.cookie, {
      email: 'it-service@msu.ac.th',
      name: 'ระบบสารสนเทศ',
      accountType: 'service',
      orgUnitId,
      responsibleUserId: responsible.id,
    });
    expect(created.status).toBe(201);

    const { res } = await loginMsu(null, { email: 'it-service@msu.ac.th' });
    expect(google.sessionCookieFrom(res)).toBeDefined();
    expect(await userRow(created.body.id)).toMatchObject({ account_type: 'service', approval_status: 'approved' });
    expect(await rolesOf(created.body.id)).toEqual(['service', 'user']);
  });
});

describe('อนุมัติบัญชีหน่วยงาน', () => {
  it('ต้องกำหนดหน่วยงานและผู้รับผิดชอบก่อน', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();

    const noOrg = await pendingService({ responsibleUserId: responsible.id });
    const r1 = await post(`/admin/users/${noOrg.id}/approve`, admin.cookie);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('SERVICE_ORG_UNIT_REQUIRED');

    const noResponsible = await pendingService({ orgUnitId });
    const r2 = await post(`/admin/users/${noResponsible.id}/approve`, admin.cookie);
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('SERVICE_RESPONSIBLE_REQUIRED');
    expect(await userRow(noResponsible.id)).toMatchObject({ approval_status: 'pending' });
  });

  it('กำหนดหน่วยงานและผู้รับผิดชอบแล้วอนุมัติ → ได้ role service', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const target = await pendingService();

    const updated = await patch(`/admin/users/${target.id}`, admin.cookie, {
      orgUnitId,
      responsibleUserId: responsible.id,
      reason: 'บัญชีงานเปิดบ้าน',
    });
    expect(updated.status).toBe(204);
    const approved = await post(`/admin/users/${target.id}/approve`, admin.cookie);
    expect(approved.status).toBe(204);

    expect(await userRow(target.id)).toMatchObject({ approval_status: 'approved', responsible_user_id: responsible.id });
    expect(await rolesOf(target.id)).toEqual(['service', 'user']);
  });

  it('ผู้รับผิดชอบถูกปิดบัญชีไปก่อนอนุมัติ → อนุมัติไม่ได้', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const target = await pendingService({ orgUnitId, responsibleUserId: responsible.id });
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [responsible.id]);

    const res = await post(`/admin/users/${target.id}/approve`, admin.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('RESPONSIBLE_INVALID');
  });

  it('ผู้ที่ไม่มี user:approve อนุมัติไม่ได้ แม้มี user:update', async () => {
    await createTestRole('test_editor', ['user:update']);
    const editor = await createUser({ roles: ['user', 'staff', 'test_editor'] });
    const responsible = await staffMember();
    const target = await pendingService({ orgUnitId, responsibleUserId: responsible.id });

    const res = await post(`/admin/users/${target.id}/approve`, await loginAs(editor.id));
    expect(res.status).toBe(403);
  });
});

describe('แก้ไขบัญชีหน่วยงาน', () => {
  it('ผู้รับผิดชอบต้องเป็นบุคลากรที่ใช้งานได้ และไม่ใช่บัญชีตัวเอง', async () => {
    const admin = await superAdmin();
    const target = await pendingService({ orgUnitId });
    const student = await createUser({ accountType: 'student', roles: ['user', 'student'] });
    const inactiveStaff = await createUser({ accountType: 'staff', isActive: false });
    const expiredStaff = await createUser({ accountType: 'staff', accountExpiresAt: new Date(Date.now() - HOUR) });

    for (const responsibleUserId of [student.id, inactiveStaff.id, expiredStaff.id, target.id, crypto.randomUUID()]) {
      const res = await patch(`/admin/users/${target.id}`, admin.cookie, { responsibleUserId, reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('RESPONSIBLE_INVALID');
    }
  });

  it('วันหมดอายุและผู้รับผิดชอบใช้กับบัญชีประเภทอื่นไม่ได้', async () => {
    const admin = await superAdmin();
    const external = await createUser({ accountType: 'external', roles: ['user', 'external'] });
    const responsible = await staffMember();

    const r1 = await patch(`/admin/users/${external.id}`, admin.cookie, {
      accountExpiresAt: new Date(Date.now() + HOUR).toISOString(),
      reason: 'x',
    });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('SERVICE_ONLY_FIELD');
    const r2 = await patch(`/admin/users/${external.id}`, admin.cookie, { responsibleUserId: responsible.id, reason: 'x' });
    expect(r2.body.error.code).toBe('SERVICE_ONLY_FIELD');
  });

  it('วันหมดอายุต้องเป็นอนาคต และบันทึก audit log', async () => {
    const admin = await superAdmin();
    const target = await pendingService({ orgUnitId });

    const past = await patch(`/admin/users/${target.id}`, admin.cookie, {
      accountExpiresAt: new Date(Date.now() - HOUR).toISOString(),
      reason: 'x',
    });
    expect(past.status).toBe(400);
    expect(past.body.error.code).toBe('EXPIRY_IN_PAST');

    const expiresAt = new Date(Date.now() + 30 * 24 * HOUR);
    const ok = await patch(`/admin/users/${target.id}`, admin.cookie, {
      accountExpiresAt: expiresAt.toISOString(),
      reason: 'กิจกรรมจบสิ้นเดือน',
    });
    expect(ok.status).toBe(204);
    expect((await userRow(target.id)).account_expires_at).toEqual(expiresAt);

    const { rows } = await pool.query(
      `SELECT changes FROM user_audit_logs WHERE target_user_id = $1 AND action = 'update'`,
      [target.id],
    );
    expect(rows[0].changes).toEqual({ accountExpiresAt: { from: null, to: expiresAt.toISOString() } });
  });

  it('บัญชีหน่วยงานที่อนุมัติแล้วล้างผู้รับผิดชอบหรือหน่วยงานไม่ได้', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const target = await createUser({
      accountType: 'service',
      roles: ['user', 'service'],
      orgUnitId,
      responsibleUserId: responsible.id,
    });

    const r1 = await patch(`/admin/users/${target.id}`, admin.cookie, { responsibleUserId: null, reason: 'x' });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('SERVICE_RESPONSIBLE_REQUIRED');
    const r2 = await patch(`/admin/users/${target.id}`, admin.cookie, { orgUnitId: null, reason: 'x' });
    expect(r2.body.error.code).toBe('SERVICE_ORG_UNIT_REQUIRED');
  });

  it('เปลี่ยนบุคลากรที่อนุมัติแล้วเป็นบัญชีหน่วยงาน ต้องระบุหน่วยงานและผู้รับผิดชอบพร้อมกัน → role เปลี่ยนตาม', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const target = await createUser({ accountType: 'staff', roles: ['user', 'staff'] });

    const missing = await patch(`/admin/users/${target.id}`, admin.cookie, { accountType: 'service', reason: 'x' });
    expect(missing.status).toBe(409);

    const ok = await patch(`/admin/users/${target.id}`, admin.cookie, {
      accountType: 'service',
      orgUnitId,
      responsibleUserId: responsible.id,
      reason: 'เป็นบัญชีกลางของกอง',
    });
    expect(ok.status).toBe(204);
    expect(await rolesOf(target.id)).toEqual(['service', 'user']);
  });

  it('เปลี่ยนบัญชีหน่วยงานเป็นประเภทอื่น → ล้างวันหมดอายุและผู้รับผิดชอบ', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const target = await createUser({
      accountType: 'service',
      roles: ['user', 'service'],
      orgUnitId,
      responsibleUserId: responsible.id,
      accountExpiresAt: new Date(Date.now() + HOUR),
    });

    const res = await patch(`/admin/users/${target.id}`, admin.cookie, { accountType: 'external', reason: 'x' });
    expect(res.status).toBe(204);
    expect(await userRow(target.id)).toMatchObject({
      account_type: 'external',
      responsible_user_id: null,
      account_expires_at: null,
    });
    expect(await rolesOf(target.id)).toEqual(['external', 'user']);
  });

  it('รายละเอียดผู้ใช้แสดงวันหมดอายุและผู้รับผิดชอบ', async () => {
    const admin = await superAdmin();
    const responsible = await createUser({ name: 'สมชาย ผู้ดูแล', email: 'somchai.s@msu.ac.th' });
    const expiresAt = new Date(Date.now() + HOUR);
    const target = await pendingService({ orgUnitId, responsibleUserId: responsible.id });
    await pool.query(`UPDATE users SET account_expires_at = $2 WHERE id = $1`, [target.id, expiresAt]);

    const res = await request(app).get(`/admin/users/${target.id}`).set('Cookie', admin.cookie);
    expect(res.body.user).toMatchObject({
      accountExpiresAt: expiresAt.toISOString(),
      responsibleUser: { id: responsible.id, displayName: 'สมชาย ผู้ดูแล', email: 'somchai.s@msu.ac.th' },
    });
  });
});

describe('ลงทะเบียนบัญชีหน่วยงานล่วงหน้า', () => {
  it('ต้องระบุหน่วยงานและผู้รับผิดชอบ', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const base = { email: 'unit@msu.ac.th', name: 'บัญชีหน่วยงาน', accountType: 'service' };

    const noOrg = await post('/admin/users', admin.cookie, { ...base, responsibleUserId: responsible.id });
    expect(noOrg.body.error.code).toBe('SERVICE_ORG_UNIT_REQUIRED');
    const noResponsible = await post('/admin/users', admin.cookie, { ...base, orgUnitId });
    expect(noResponsible.body.error.code).toBe('SERVICE_RESPONSIBLE_REQUIRED');
  });

  it('บันทึกวันหมดอายุและผู้รับผิดชอบ ได้ role user + service', async () => {
    const admin = await superAdmin();
    const responsible = await staffMember();
    const expiresAt = new Date(Date.now() + 7 * 24 * HOUR);
    const res = await post('/admin/users', admin.cookie, {
      email: 'openhouse2026@msu.ac.th',
      name: 'งานเปิดบ้าน 2569',
      accountType: 'service',
      orgUnitId,
      responsibleUserId: responsible.id,
      accountExpiresAt: expiresAt.toISOString(),
    });
    expect(res.status).toBe(201);
    expect(await userRow(res.body.id)).toMatchObject({
      account_type: 'service',
      approval_status: 'approved',
      org_unit_id: orgUnitId,
      responsible_user_id: responsible.id,
      account_expires_at: expiresAt,
    });
    expect(await rolesOf(res.body.id)).toEqual(['service', 'user']);
  });

  it('บัญชีประเภทอื่นส่งวันหมดอายุมาไม่ได้', async () => {
    const admin = await superAdmin();
    const res = await post('/admin/users', admin.cookie, {
      email: 'guest@gmail.com',
      name: 'แขก',
      accountType: 'external',
      accountExpiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVICE_ONLY_FIELD');
  });
});

describe('บัญชีหมดอายุ', () => {
  async function expiredService() {
    const responsible = await staffMember();
    return createUser({
      accountType: 'service',
      roles: ['user', 'service'],
      orgUnitId,
      responsibleUserId: responsible.id,
      accountExpiresAt: new Date(Date.now() - 1000),
    });
  }

  it('ถึงเวลาแล้วใช้ session เดิมไม่ได้ทันที (ไม่ต้องรอ job) และ session ถูกเพิกถอน', async () => {
    const target = await expiredService();
    const cookie = await loginAs(target.id);

    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
    const { rows } = await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [target.id]);
    expect(rows).toHaveLength(0);
  });

  it('login ด้วย Google ไม่ได้ → ACCOUNT_DISABLED', async () => {
    const sub = 'google-expired';
    await loginMsu(null, { sub });
    await pool.query(`UPDATE users SET account_expires_at = now() - interval '1 minute'`);
    await pool.query(`DELETE FROM sessions`);

    const { res } = await loginMsu(null, { sub });
    expect(res.headers.location).toBe(`${WEB_URL}/login?error=ACCOUNT_DISABLED`);
    expect(google.sessionCookieFrom(res)).toBeUndefined();
  });

  it('job ปิดเฉพาะบัญชีที่หมดอายุ เพิกถอน session และเขียน audit log โดยระบบ', async () => {
    const expired = await expiredService();
    const future = await createUser({ accountType: 'service', accountExpiresAt: new Date(Date.now() + HOUR) });
    const noExpiry = await createUser({ accountType: 'service' });
    await loginAs(expired.id);

    expect(await expireAccounts()).toBe(1);
    expect(await userRow(expired.id)).toMatchObject({ is_active: false, deactivated: true, deactivated_by: null });
    expect(await userRow(future.id)).toMatchObject({ is_active: true });
    expect(await userRow(noExpiry.id)).toMatchObject({ is_active: true });

    const sessions = await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [expired.id]);
    expect(sessions.rows).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT action, actor_id, changes FROM user_audit_logs WHERE target_user_id = $1`,
      [expired.id],
    );
    expect(rows).toEqual([
      { action: 'expire', actor_id: null, changes: { isActive: { from: true, to: false }, revokedSessions: 1, revokedCertificates: 0 } },
    ]);

    // รันซ้ำไม่ปิดซ้ำ
    expect(await expireAccounts()).toBe(0);
  });

  it('เปิดบัญชีที่หมดอายุคืนต้องขยายวันหมดอายุก่อน', async () => {
    const admin = await superAdmin();
    const target = await expiredService();
    await expireAccounts();

    const blocked = await post(`/admin/users/${target.id}/activate`, admin.cookie, { reason: 'ใช้ต่อ' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ACCOUNT_EXPIRED');

    const extended = await patch(`/admin/users/${target.id}`, admin.cookie, {
      accountExpiresAt: new Date(Date.now() + 24 * HOUR).toISOString(),
      reason: 'ขยายกิจกรรม',
    });
    expect(extended.status).toBe(204);
    const activated = await post(`/admin/users/${target.id}/activate`, admin.cookie, { reason: 'ใช้ต่อ' });
    expect(activated.status).toBe(204);
    expect(await userRow(target.id)).toMatchObject({ is_active: true });
  });
});
