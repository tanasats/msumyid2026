import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// กำหนด role และสิทธิ์ของ role (/admin/role-permissions) — super_admin เท่านั้น (canManageRoles)
// ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const send = (method: 'post' | 'patch' | 'put', path: string, cookie: string, body: object) =>
  request(app)[method](path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

const setPermissions = (cookie: string, code: string, permissions: string[], reason = 'ตามคำสั่งมหาวิทยาลัย') =>
  send('put', `/admin/role-permissions/roles/${code}/permissions`, cookie, { permissions, reason });

const me = (cookie: string) => request(app).get('/auth/me').set('Cookie', cookie);

describe('สิทธิ์เข้าใช้ (super_admin เท่านั้น)', () => {
  it('ยังไม่ login → 401 / ผู้ใช้ทั่วไป → 403', async () => {
    expect((await request(app).get('/admin/role-permissions')).status).toBe(401);
    const user = await createUser();
    const cookie = await loginAs(user.id);
    expect((await request(app).get('/admin/role-permissions').set('Cookie', cookie)).status).toBe(403);
    expect((await setPermissions(cookie, 'staff', ['user:read'])).status).toBe(403);
  });

  it('ถือ role admin และมีทุก permission ผ่าน role อื่น ก็ยังเข้าไม่ได้ (กันยกระดับสิทธิ์ตัวเอง)', async () => {
    const codes = (await pool.query<{ code: string }>('SELECT code FROM permissions')).rows.map((r) => r.code);
    await createTestRole('test_everything', codes);
    const user = await createUser({ roles: ['user', 'staff', 'admin', 'test_everything'] });
    const cookie = await loginAs(user.id);
    expect((await request(app).get('/admin/role-permissions').set('Cookie', cookie)).status).toBe(403);
    expect((await setPermissions(cookie, 'staff', ['user:read'])).status).toBe(403);
    expect((await me(cookie)).body.user.capabilities).toEqual({ manageRoles: false });
  });

  it('/auth/me บอก capabilities ให้ web ซ่อน/แสดงเมนู (ไม่ต้องเช็คชื่อ role)', async () => {
    const admin = await superAdmin();
    expect((await me(admin.cookie)).body.user.capabilities).toEqual({ manageRoles: true });
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const admin = await superAdmin();
    const res = await request(app)
      .put('/admin/role-permissions/roles/staff/permissions')
      .set('Cookie', admin.cookie)
      .send({ permissions: ['user:read'], reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });
});

describe('ภาพรวม', () => {
  it('role ทั้งหมดพร้อมจำนวนผู้ถือ (ไม่นับบัญชีที่ลบ) และ permission ทั้งหมดพร้อมคำอธิบาย', async () => {
    const admin = await superAdmin();
    await createUser({ roles: ['user', 'staff'] });
    const deleted = await createUser({ roles: ['user', 'staff'] });
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.id]);

    const res = await request(app).get('/admin/role-permissions').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    const staff = res.body.roles.find((r: { code: string }) => r.code === 'staff');
    // admin เองถือ staff ด้วย
    expect(staff).toMatchObject({ isSystem: true, holderCount: 2, permissionCodes: [], hasAllPermissions: false });
    expect(res.body.roles.find((r: { code: string }) => r.code === 'super_admin').hasAllPermissions).toBe(true);
    expect(res.body.permissions).toEqual(
      expect.arrayContaining([{ code: 'user:read', descriptionTh: 'ดูรายชื่อ ค้นหา และดูรายละเอียดผู้ใช้' }]),
    );
    expect(res.body.logs).toEqual([]);
  });
});

describe('กำหนดสิทธิ์ของ role', () => {
  it('ผูก permission → ผู้ถือ role ได้สิทธิ์ทันที (ไม่ต้อง login ใหม่) และ log ทีละรายการพร้อมเหตุผล', async () => {
    const admin = await superAdmin();
    const staff = await createUser({ roles: ['user', 'staff'] });
    const staffCookie = await loginAs(staff.id);
    expect((await request(app).get('/admin/users').set('Cookie', staffCookie)).status).toBe(403);

    const res = await setPermissions(admin.cookie, 'staff', ['user:read', 'certificate:request']);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ granted: ['certificate:request', 'user:read'], revoked: [] });

    expect((await request(app).get('/admin/users').set('Cookie', staffCookie)).status).toBe(200);
    expect([...(await me(staffCookie)).body.user.permissions].sort()).toEqual(['certificate:request', 'user:read']);

    const { rows } = await pool.query(
      `SELECT l.action, p.code, l.actor_id, l.reason
       FROM role_permission_logs l JOIN permissions p ON p.id = l.permission_id ORDER BY p.code`,
    );
    expect(rows).toEqual([
      { action: 'grant', code: 'certificate:request', actor_id: admin.id, reason: 'ตามคำสั่งมหาวิทยาลัย' },
      { action: 'grant', code: 'user:read', actor_id: admin.id, reason: 'ตามคำสั่งมหาวิทยาลัย' },
    ]);
  });

  it('ส่งชุดใหม่ → ผูก/ถอนเฉพาะที่ต่าง, ถอนแล้วหมดสิทธิ์ทันที / ชุดเดิม → 400 NO_CHANGES', async () => {
    const admin = await superAdmin();
    const staff = await createUser({ roles: ['user', 'staff'] });
    const staffCookie = await loginAs(staff.id);
    await setPermissions(admin.cookie, 'staff', ['user:read', 'certificate:request']);

    const res = await setPermissions(admin.cookie, 'staff', ['certificate:request', 'document:sign']);
    expect(res.body).toMatchObject({ granted: ['document:sign'], revoked: ['user:read'] });
    expect((await request(app).get('/admin/users').set('Cookie', staffCookie)).status).toBe(403);

    const same = await setPermissions(admin.cookie, 'staff', ['document:sign', 'certificate:request']);
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('NO_CHANGES');
  });

  it('ผู้ใช้หลาย role ได้สิทธิ์รวมกัน (union)', async () => {
    const admin = await superAdmin();
    await setPermissions(admin.cookie, 'staff', ['user:read']);
    await setPermissions(admin.cookie, 'admin', ['user:deactivate']);
    const user = await createUser({ roles: ['user', 'staff', 'admin'] });
    expect([...(await me(await loginAs(user.id))).body.user.permissions].sort()).toEqual(['user:deactivate', 'user:read']);
  });

  it('super_admin → 409 (ได้ทุกสิทธิ์อยู่แล้ว) / permission ที่ไม่มี → 422 / role ที่ไม่มี → 404 / ไม่มีเหตุผล → 400', async () => {
    const admin = await superAdmin();
    expect((await setPermissions(admin.cookie, 'super_admin', ['user:read'])).body.error.code).toBe('SUPER_ADMIN_HAS_ALL');
    expect((await setPermissions(admin.cookie, 'staff', ['user:fly'])).body.error.code).toBe('PERMISSION_NOT_FOUND');
    expect((await setPermissions(admin.cookie, 'nobody', ['user:read'])).status).toBe(404);
    expect((await setPermissions(admin.cookie, 'staff', ['user:read'], '  ')).status).toBe(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM role_permission_logs');
    expect(rows[0].n).toBe(0);
  });

  it('แก้ role เดียวกันพร้อมกัน → ไม่มี log ซ้ำ (ล็อกแถว role)', async () => {
    const admin = await superAdmin();
    const results = await Promise.all([1, 2, 3].map(() => setPermissions(admin.cookie, 'staff', ['user:read'])));
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM role_permission_logs WHERE action = 'grant'");
    expect(rows[0].n).toBe(1);
  });
});

describe('สร้าง / เปลี่ยนชื่อ role', () => {
  it('สร้าง role → ไม่ใช่ role ระบบ ให้ผู้ใช้ได้ และกำหนดสิทธิ์ได้ / code ซ้ำ → 409 / code ผิดรูปแบบ → 400', async () => {
    const admin = await superAdmin();
    const res = await send('post', '/admin/role-permissions/roles', admin.cookie, {
      code: 'test_registrar',
      nameTh: 'เจ้าหน้าที่ทะเบียน',
      reason: 'โครงสร้างงานใหม่',
    });
    expect(res.status).toBe(201);
    expect(res.body.roles.find((r: { code: string }) => r.code === 'test_registrar')).toMatchObject({
      nameTh: 'เจ้าหน้าที่ทะเบียน',
      isSystem: false,
      isPrivileged: false,
      holderCount: 0,
    });
    expect((await setPermissions(admin.cookie, 'test_registrar', ['user:read'])).status).toBe(200);

    const dup = await send('post', '/admin/role-permissions/roles', admin.cookie, { code: 'test_registrar', nameTh: 'x', reason: 'x' });
    expect(dup.body.error.code).toBe('ROLE_CODE_EXISTS');
    for (const code of ['Test', '9abc', 'a', 'มี-ไทย', 'a-b']) {
      expect((await send('post', '/admin/role-permissions/roles', admin.cookie, { code, nameTh: 'x', reason: 'x' })).status).toBe(400);
    }
    expect(res.body.logs[0]).toMatchObject({
      action: 'create',
      role: { code: 'test_registrar' },
      detail: { code: 'test_registrar', nameTh: 'เจ้าหน้าที่ทะเบียน', isPrivileged: false },
      actor: { id: admin.id },
    });
  });

  it('role สิทธิ์สูงที่สร้างใหม่ → ให้/ถอนได้เฉพาะ super_admin (กฎ canGrantRole เดิม)', async () => {
    const admin = await superAdmin();
    await send('post', '/admin/role-permissions/roles', admin.cookie, {
      code: 'test_auditor',
      nameTh: 'ผู้ตรวจสอบ',
      isPrivileged: true,
      reason: 'x',
    });
    await createTestRole('test_assigner', ['user_role:assign']);
    const assigner = await createUser({ roles: ['user', 'staff', 'test_assigner'] });
    const target = await createUser();
    const res = await send('post', `/admin/users/${target.id}/roles/test_auditor`, await loginAs(assigner.id), { reason: 'x' });
    expect(res.body.error.code).toBe('PRIVILEGED_ROLE');
  });

  it('เปลี่ยนชื่อไทย (รวม role ระบบ) พร้อม log ชื่อเดิม/ใหม่ / ชื่อเดิม → 400', async () => {
    const admin = await superAdmin();
    const res = await send('patch', '/admin/role-permissions/roles/staff', admin.cookie, { nameTh: 'บุคลากรสายสนับสนุน', reason: 'ปรับชื่อ' });
    expect(res.status).toBe(200);
    expect(res.body.roles.find((r: { code: string }) => r.code === 'staff').nameTh).toBe('บุคลากรสายสนับสนุน');
    expect(res.body.logs[0]).toMatchObject({ action: 'rename', detail: { from: 'บุคลากร', to: 'บุคลากรสายสนับสนุน' } });
    await pool.query("UPDATE roles SET name_th = 'บุคลากร' WHERE code = 'staff'");

    const same = await send('patch', '/admin/role-permissions/roles/staff', admin.cookie, { nameTh: 'บุคลากร', reason: 'x' });
    expect(same.body.error.code).toBe('NO_CHANGES');
  });
});

it('ประวัติแก้/ลบไม่ได้ (append-only)', async () => {
  const admin = await superAdmin();
  await setPermissions(admin.cookie, 'staff', ['user:read']);
  await expect(pool.query('DELETE FROM role_permission_logs')).rejects.toThrow();
  await expect(pool.query("UPDATE role_permission_logs SET reason = 'x'")).rejects.toThrow();
});
