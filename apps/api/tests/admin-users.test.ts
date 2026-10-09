import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { upsertGoogleUser } from '../src/repositories/user-repository.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ระบบจัดการบัญชีผู้ใช้ — ฐานข้อมูลจริง app_test (CLAUDE.md หัวข้อ 15)

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

/** ผู้ใช้ที่มีเฉพาะ permission ที่กำหนด ผ่าน role ทดสอบ */
async function userWithPermissions(...permissions: string[]) {
  await createTestRole('test_operator', permissions);
  const user = await createUser({ roles: ['user', 'test_operator'] });
  return { ...user, cookie: await loginAs(user.id) };
}

function post(path: string, cookie: string, body: object = {}) {
  return request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
}

function del(path: string, cookie: string, body: object = {}) {
  return request(app).delete(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
}

async function userState(id: string) {
  const { rows } = await pool.query(
    `SELECT is_active, deactivated_by, approval_status, approved_by FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function auditLogs(targetId: string) {
  const { rows } = await pool.query(
    `SELECT action, actor_id, reason, changes FROM user_audit_logs WHERE target_user_id = $1 ORDER BY created_at`,
    [targetId],
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

describe('สิทธิ์เข้าถึง', () => {
  it('ยังไม่ login → 401', async () => {
    expect((await request(app).get('/admin/users')).status).toBe(401);
  });

  it('ผู้ใช้ทั่วไป (ไม่มี user:read) → 403', async () => {
    const user = await createUser();
    const res = await request(app).get('/admin/users').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
  });

  it('มี user:read → ดูรายชื่อได้ แต่ปิดบัญชีไม่ได้', async () => {
    const reader = await userWithPermissions('user:read');
    const target = await createUser();
    expect((await request(app).get('/admin/users').set('Cookie', reader.cookie)).status).toBe(200);
    const res = await post(`/admin/users/${target.id}/deactivate`, reader.cookie, { reason: 'ทดสอบ' });
    expect(res.status).toBe(403);
  });

  it('สิทธิ์จากหลาย role รวมกัน: user:read + user:deactivate จาก 2 role', async () => {
    await createTestRole('test_reader', ['user:read']);
    await createTestRole('test_deactivator', ['user:deactivate']);
    const operator = await createUser({ roles: ['user', 'test_reader', 'test_deactivator'] });
    const cookie = await loginAs(operator.id);
    const target = await createUser();
    expect((await request(app).get(`/admin/users/${target.id}`).set('Cookie', cookie)).status).toBe(200);
    expect((await post(`/admin/users/${target.id}/deactivate`, cookie, { reason: 'ทดสอบ' })).status).toBe(204);
  });

  it('super_admin ใช้ได้ทุก endpoint (permission ยังไม่ผูกกับ role ใด)', async () => {
    const admin = await superAdmin();
    expect((await request(app).get('/admin/users').set('Cookie', admin.cookie)).status).toBe(200);
    expect((await request(app).get('/admin/roles').set('Cookie', admin.cookie)).status).toBe(200);
  });
});

describe('GET /admin/users', () => {
  it('ค้นหาจากชื่อแสดงหรือ email บางส่วน (ไม่สนตัวพิมพ์)', async () => {
    const admin = await superAdmin();
    await createUser({ name: 'สมชาย ใจดี', email: 'somchai.j@msu.ac.th' });
    await createUser({ name: 'สมหญิง รักเรียน', email: 'somying.r@msu.ac.th' });

    const byName = await request(app).get('/admin/users').query({ q: 'ใจดี' }).set('Cookie', admin.cookie);
    expect(byName.body.users.map((u: { displayName: string }) => u.displayName)).toEqual(['สมชาย ใจดี']);

    const byEmail = await request(app).get('/admin/users').query({ q: 'SOMYING' }).set('Cookie', admin.cookie);
    expect(byEmail.body.users.map((u: { email: string }) => u.email)).toEqual(['somying.r@msu.ac.th']);
  });

  it('อักขระ % และ _ ถูกค้นหาตามตัวอักษร ไม่ใช่ wildcard', async () => {
    const admin = await superAdmin();
    await createUser({ name: 'ทดสอบ' });
    const res = await request(app).get('/admin/users').query({ q: '%' }).set('Cookie', admin.cookie);
    expect(res.body.users).toEqual([]);
  });

  it('กรองตามสถานะ ประเภทบัญชี และ role', async () => {
    const admin = await superAdmin();
    const pending = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    const inactive = await createUser({ isActive: false });
    const student = await createUser({ accountType: 'student', roles: ['user', 'student'] });

    const ids = async (query: object) =>
      (await request(app).get('/admin/users').query(query).set('Cookie', admin.cookie)).body.users.map(
        (u: { id: string }) => u.id,
      );
    expect(await ids({ status: 'pending' })).toEqual([pending.id]);
    expect(await ids({ status: 'inactive' })).toEqual([inactive.id]);
    expect(await ids({ accountType: 'student' })).toEqual([student.id]);
    expect(await ids({ role: 'super_admin' })).toEqual([admin.id]);
  });

  it('แบ่งหน้าแบบ cursor: ครบทุกคน ไม่ซ้ำ และเรียงใหม่ไปเก่า', async () => {
    const admin = await superAdmin();
    for (let i = 0; i < 24; i += 1) await createUser();

    const first = await request(app).get('/admin/users').set('Cookie', admin.cookie);
    expect(first.body.users).toHaveLength(20);
    expect(first.body.nextCursor).toBe(first.body.users[19].id);

    const second = await request(app)
      .get('/admin/users')
      .query({ cursor: first.body.nextCursor })
      .set('Cookie', admin.cookie);
    expect(second.body.users).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();

    const all = [...first.body.users, ...second.body.users].map((u: { id: string }) => u.id);
    expect(new Set(all).size).toBe(25);
    expect(all).toEqual([...all].sort().reverse());
  });

  it('ไม่แสดงผู้ใช้ที่ถูกลบ และ query ผิดรูปแบบ → 400', async () => {
    const admin = await superAdmin();
    const deleted = await createUser();
    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted.id]);
    const res = await request(app).get('/admin/users').set('Cookie', admin.cookie);
    expect(res.body.users.map((u: { id: string }) => u.id)).toEqual([admin.id]);

    const bad = await request(app).get('/admin/users').query({ status: 'all' }).set('Cookie', admin.cookie);
    expect(bad.status).toBe(400);
  });
});

describe('GET /admin/users/:id', () => {
  it('คืนรายละเอียด role และบอกว่าจัดการได้หรือไม่', async () => {
    const admin = await superAdmin();
    const target = await createUser({ roles: ['user', 'staff'] });
    const res = await request(app).get(`/admin/users/${target.id}`).set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.user.roles.map((r: { code: string }) => r.code).sort()).toEqual(['staff', 'user']);
    expect(res.body).toMatchObject({ manageable: true, isSelf: false, staffProfile: null, history: [] });

    const self = await request(app).get(`/admin/users/${admin.id}`).set('Cookie', admin.cookie);
    expect(self.body).toMatchObject({ manageable: false, isSelf: true });
  });

  it('ไม่พบ → 404, id ไม่ใช่ uuid → 400', async () => {
    const admin = await superAdmin();
    const missing = await request(app).get(`/admin/users/${crypto.randomUUID()}`).set('Cookie', admin.cookie);
    expect(missing.status).toBe(404);
    expect((await request(app).get('/admin/users/abc').set('Cookie', admin.cookie)).status).toBe(400);
  });
});

describe('ปิด/เปิดบัญชี', () => {
  it('ปิดบัญชี: ใช้งานไม่ได้ทันที เพิกถอน session และบันทึก log พร้อมเหตุผล', async () => {
    const admin = await superAdmin();
    const target = await createUser();
    const targetCookie = await loginAs(target.id);

    const res = await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: 'ลาออกแล้ว' });
    expect(res.status).toBe(204);
    expect(await userState(target.id)).toMatchObject({ is_active: false, deactivated_by: admin.id });
    const sessions = await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [target.id]);
    expect(sessions.rows).toHaveLength(0);
    expect((await request(app).get('/auth/me').set('Cookie', targetCookie)).status).toBe(401);
    expect(await auditLogs(target.id)).toEqual([
      {
        action: 'deactivate',
        actor_id: admin.id,
        reason: 'ลาออกแล้ว',
        changes: { isActive: { from: true, to: false }, revokedSessions: 1, revokedCertificates: 0 },
      },
    ]);
  });

  it('เปิดบัญชีคืน: ล้างข้อมูลผู้ปิด และบันทึก log', async () => {
    const admin = await superAdmin();
    const target = await createUser();
    await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: 'ปิดชั่วคราว' });

    const res = await post(`/admin/users/${target.id}/activate`, admin.cookie, { reason: 'กลับมาทำงาน' });
    expect(res.status).toBe(204);
    expect(await userState(target.id)).toMatchObject({ is_active: true, deactivated_by: null });
    expect((await auditLogs(target.id)).map((l) => l.action)).toEqual(['deactivate', 'activate']);
  });

  it('ต้องระบุเหตุผล → 400 / ปิดซ้ำ → 409', async () => {
    const admin = await superAdmin();
    const target = await createUser();
    expect((await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: '  ' })).status).toBe(400);
    await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: 'ทดสอบ' });
    const again = await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: 'ทดสอบ' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_INACTIVE');
  });

  it('ห้ามปิดบัญชีตัวเอง', async () => {
    const admin = await superAdmin();
    const res = await post(`/admin/users/${admin.id}/deactivate`, admin.cookie, { reason: 'ทดสอบ' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_MANAGE_SELF');
  });

  it('ผู้มี user:deactivate แต่ไม่ใช่ super_admin ปิดบัญชีผู้ถือ role สิทธิ์สูงไม่ได้', async () => {
    const operator = await userWithPermissions('user:deactivate');
    const target = await createUser({ roles: ['user', 'admin'] });
    const res = await post(`/admin/users/${target.id}/deactivate`, operator.cookie, { reason: 'ทดสอบ' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PRIVILEGED_TARGET');
  });

  it('super_admin 2 คนปิดบัญชีกันเองพร้อมกัน → สำเร็จ 1 คน อีกคนถูกปฏิเสธ (เหลือ super_admin เสมอ)', async () => {
    const a = await superAdmin();
    const b = await superAdmin();
    const results = await Promise.all([
      post(`/admin/users/${b.id}/deactivate`, a.cookie, { reason: 'ทดสอบ' }),
      post(`/admin/users/${a.id}/deactivate`, b.cookie, { reason: 'ทดสอบ' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    // คนที่สองอาจได้ 409 (เหลือคนเดียว) หรือ 401 (session ของตัวเองถูกเพิกถอนไปแล้ว)
    expect(statuses[0]).toBe(204);
    expect([401, 409]).toContain(statuses[1]);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE is_active`);
    expect(rows[0].n).toBe(1);
  });
});

describe('อนุมัติ/ปฏิเสธบุคลากรภายนอก', () => {
  it('อนุมัติ: เปลี่ยนสถานะ ให้ role external และบันทึกทั้ง 2 log', async () => {
    const admin = await superAdmin();
    const target = await createUser({ accountType: 'external', approvalStatus: 'pending' });

    const res = await post(`/admin/users/${target.id}/approve`, admin.cookie);
    expect(res.status).toBe(204);
    expect(await userState(target.id)).toMatchObject({ approval_status: 'approved', approved_by: admin.id });
    expect(await rolesOf(target.id)).toEqual(['external', 'user']);
    expect((await auditLogs(target.id)).map((l) => l.action)).toEqual(['approve']);
    const roleLogs = await pool.query(
      `SELECT action, actor_id FROM role_change_logs WHERE target_user_id = $1`,
      [target.id],
    );
    expect(roleLogs.rows).toEqual([{ action: 'grant', actor_id: admin.id }]);
  });

  it('ปฏิเสธ: ต้องมีเหตุผล และทำได้เฉพาะบัญชีที่รออนุมัติ', async () => {
    const admin = await superAdmin();
    const target = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    expect((await post(`/admin/users/${target.id}/reject`, admin.cookie)).status).toBe(400);

    const res = await post(`/admin/users/${target.id}/reject`, admin.cookie, { reason: 'ไม่ใช่ผู้เกี่ยวข้อง' });
    expect(res.status).toBe(204);
    expect(await userState(target.id)).toMatchObject({ approval_status: 'rejected' });

    const again = await post(`/admin/users/${target.id}/reject`, admin.cookie, { reason: 'ซ้ำ' });
    expect(again.body.error.code).toBe('NOT_PENDING');
  });

  it('ผู้มีแค่ user:read อนุมัติไม่ได้', async () => {
    const reader = await userWithPermissions('user:read');
    const target = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    expect((await post(`/admin/users/${target.id}/approve`, reader.cookie)).status).toBe(403);
  });
});

describe('ให้/ถอน role', () => {
  it('ผู้มี user_role:assign ให้และถอน role ทั่วไปได้ พร้อม role_change_logs', async () => {
    await pool.query(`INSERT INTO roles (code, name_th) VALUES ('test_officer', 'เจ้าหน้าที่ทดสอบ')`);
    const operator = await userWithPermissions('user_role:assign');
    const target = await createUser();

    const grant = await post(`/admin/users/${target.id}/roles/test_officer`, operator.cookie, { reason: 'มอบหมายงาน' });
    expect(grant.status).toBe(204);
    expect(await rolesOf(target.id)).toEqual(['test_officer', 'user']);

    const revoke = await del(`/admin/users/${target.id}/roles/test_officer`, operator.cookie, { reason: 'ย้ายงาน' });
    expect(revoke.status).toBe(204);
    expect(await rolesOf(target.id)).toEqual(['user']);

    const { rows } = await pool.query(
      `SELECT action, actor_id, reason FROM role_change_logs WHERE target_user_id = $1 ORDER BY created_at`,
      [target.id],
    );
    expect(rows).toEqual([
      { action: 'grant', actor_id: operator.id, reason: 'มอบหมายงาน' },
      { action: 'revoke', actor_id: operator.id, reason: 'ย้ายงาน' },
    ]);
  });

  it('role สิทธิ์สูงให้ได้เฉพาะ super_admin', async () => {
    const operator = await userWithPermissions('user_role:assign');
    const admin = await superAdmin();
    const target = await createUser();

    const denied = await post(`/admin/users/${target.id}/roles/admin`, operator.cookie, { reason: 'ทดสอบ' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PRIVILEGED_ROLE');
    expect((await post(`/admin/users/${target.id}/roles/admin`, admin.cookie, { reason: 'ทดสอบ' })).status).toBe(204);
  });

  it('role ที่ระบบจัดการเอง (user/student/staff/external) แก้ด้วยมือไม่ได้ — รวมถอน user', async () => {
    const admin = await superAdmin();
    const target = await createUser({ roles: ['user', 'staff'] });
    for (const code of ['user', 'staff']) {
      const res = await del(`/admin/users/${target.id}/roles/${code}`, admin.cookie, { reason: 'ทดสอบ' });
      expect(res.body.error.code).toBe('SYSTEM_ROLE');
    }
    const grant = await post(`/admin/users/${target.id}/roles/external`, admin.cookie, { reason: 'ทดสอบ' });
    expect(grant.body.error.code).toBe('SYSTEM_ROLE');
  });

  it('ห้ามแก้ role ของตัวเอง', async () => {
    const admin = await superAdmin();
    const res = await post(`/admin/users/${admin.id}/roles/admin`, admin.cookie, { reason: 'ทดสอบ' });
    expect(res.body.error.code).toBe('CANNOT_MANAGE_SELF');
  });

  it('ถอน super_admin จากผู้ดูแลอีกคนได้เมื่อยังเหลือตัวเอง', async () => {
    const a = await superAdmin();
    const b = await superAdmin();
    const res = await del(`/admin/users/${b.id}/roles/super_admin`, a.cookie, { reason: 'ทดสอบ' });
    expect(res.status).toBe(204);
    expect(await rolesOf(b.id)).toEqual(['staff', 'user']);
  });

  it('ให้ซ้ำ → 409, ถอน role ที่ไม่มี → 409, role ไม่มีจริง → 404', async () => {
    const admin = await superAdmin();
    const target = await createUser();
    await post(`/admin/users/${target.id}/roles/admin`, admin.cookie, { reason: 'ทดสอบ' });
    expect((await post(`/admin/users/${target.id}/roles/admin`, admin.cookie, { reason: 'ซ้ำ' })).status).toBe(409);
    const other = await createUser();
    expect((await del(`/admin/users/${other.id}/roles/admin`, admin.cookie, { reason: 'ทดสอบ' })).status).toBe(409);
    expect((await post(`/admin/users/${other.id}/roles/no_such_role`, admin.cookie, { reason: 'x' })).status).toBe(
      404,
    );
  });

  it('GET /admin/roles บอกว่า role ใดผู้เรียกให้ได้', async () => {
    const operator = await userWithPermissions('user:read', 'user_role:assign');
    const res = await request(app).get('/admin/roles').set('Cookie', operator.cookie);
    const assignable = Object.fromEntries(
      res.body.roles.map((r: { code: string; assignable: boolean }) => [r.code, r.assignable]),
    );
    expect(assignable).toMatchObject({ admin: false, super_admin: false, user: false, staff: false, test_operator: true });
  });
});

describe('user_audit_logs', () => {
  it('แก้หรือลบ log ไม่ได้', async () => {
    const admin = await superAdmin();
    const target = await createUser();
    await post(`/admin/users/${target.id}/deactivate`, admin.cookie, { reason: 'ทดสอบ' });
    await expect(pool.query(`UPDATE user_audit_logs SET reason = 'แก้'`)).rejects.toThrow('แก้ไขหรือลบไม่ได้');
    await expect(pool.query(`DELETE FROM user_audit_logs`)).rejects.toThrow('แก้ไขหรือลบไม่ได้');
  });
});

describe('แก้ไขข้อมูลผู้ใช้ (PATCH /admin/users/:id)', () => {
  function patch(path: string, cookie: string, body: object) {
    return request(app).patch(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
  }

  async function userRow(id: string) {
    const { rows } = await pool.query(
      `SELECT u.name, u.display_name, u.display_name_override, u.account_type, ou.code AS org_unit_code, u.google_sub
       FROM users u LEFT JOIN org_units ou ON ou.id = u.org_unit_id WHERE u.id = $1`,
      [id],
    );
    return rows[0];
  }

  async function orgUnitId(code: string): Promise<string> {
    const { rows } = await pool.query(`SELECT id FROM org_units WHERE code = $1`, [code]);
    return rows[0].id;
  }

  it('ตั้งชื่อแสดงเอง: ใช้แทนชื่อเดิม และ log ไม่เก็บค่าชื่อ (PDPA)', async () => {
    const admin = await superAdmin();
    const target = await createUser({ name: 'ชื่อจาก Google' });

    const res = await patch(`/admin/users/${target.id}`, admin.cookie, {
      displayNameOverride: 'ชื่อที่ผู้ดูแลตั้ง',
      reason: 'สะกดชื่อผิด',
    });
    expect(res.status).toBe(204);
    expect(await userRow(target.id)).toMatchObject({
      display_name: 'ชื่อที่ผู้ดูแลตั้ง',
      display_name_override: 'ชื่อที่ผู้ดูแลตั้ง',
      name: 'ชื่อจาก Google',
    });
    const logs = await auditLogs(target.id);
    expect(logs).toEqual([
      { action: 'update', actor_id: admin.id, reason: 'สะกดชื่อผิด', changes: { displayName: 'changed' } },
    ]);
    expect(JSON.stringify(logs)).not.toContain('ชื่อที่ผู้ดูแลตั้ง');
  });

  it('ชื่อที่ผู้ดูแลตั้งไม่ถูกทับเมื่อผู้ใช้ login และได้ชื่อจาก ERP', async () => {
    const admin = await superAdmin();
    const target = await createUser({ name: 'ชื่อจาก Google' });
    await patch(`/admin/users/${target.id}`, admin.cookie, { displayNameOverride: 'ชื่อที่ตั้ง', reason: 'x' });

    const { google_sub } = await userRow(target.id);
    await upsertGoogleUser(pool, {
      googleSub: google_sub,
      email: 'x@msu.ac.th',
      name: 'Google ใหม่',
      erpDisplayName: 'ชื่อจาก ERP',
      pictureUrl: null,
      accountType: 'staff',
      orgUnitCode: null,
      approvalStatus: 'approved',
    });
    expect((await userRow(target.id)).display_name).toBe('ชื่อที่ตั้ง');
  });

  it('ล้างชื่อที่ตั้ง (ข้อความว่าง) → กลับไปใช้ชื่อจาก ERP ถ้ามี ไม่เช่นนั้นชื่อจาก Google', async () => {
    const admin = await superAdmin();
    const staff = await createUser({ name: 'Google Staff' });
    await pool.query(
      `INSERT INTO staff_profiles (user_id, staff_id, first_name_th, last_name_th, synced_at)
       VALUES ($1, '1', 'สมหญิง', 'ตัวอย่าง', now())`,
      [staff.id],
    );
    const student = await createUser({ name: 'Google Student', accountType: 'student' });

    for (const id of [staff.id, student.id]) {
      await patch(`/admin/users/${id}`, admin.cookie, { displayNameOverride: 'ชั่วคราว', reason: 'x' });
      const res = await patch(`/admin/users/${id}`, admin.cookie, { displayNameOverride: '', reason: 'ใช้ชื่อเดิม' });
      expect(res.status).toBe(204);
    }
    expect(await userRow(staff.id)).toMatchObject({ display_name: 'สมหญิง ตัวอย่าง', display_name_override: null });
    expect(await userRow(student.id)).toMatchObject({ display_name: 'Google Student', display_name_override: null });
    expect((await auditLogs(student.id))[1].changes).toEqual({ displayName: 'reset' });
  });

  it('เปลี่ยนประเภทบัญชี: ถอน role ประเภทเดิม ให้ role ประเภทใหม่ พร้อม log', async () => {
    const admin = await superAdmin();
    const target = await createUser({ accountType: 'staff', roles: ['user', 'staff'] });

    const res = await patch(`/admin/users/${target.id}`, admin.cookie, { accountType: 'student', reason: 'เป็นนิสิต' });
    expect(res.status).toBe(204);
    expect((await userRow(target.id)).account_type).toBe('student');
    expect(await rolesOf(target.id)).toEqual(['student', 'user']);

    const { rows } = await pool.query(
      `SELECT l.action, r.code, l.reason FROM role_change_logs l JOIN roles r ON r.id = l.role_id
       WHERE l.target_user_id = $1 ORDER BY l.action DESC`,
      [target.id],
    );
    expect(rows).toEqual([
      { action: 'revoke', code: 'staff', reason: 'เปลี่ยนประเภทบัญชี: เป็นนิสิต' },
      { action: 'grant', code: 'student', reason: 'เปลี่ยนประเภทบัญชี: เป็นนิสิต' },
    ]);
    expect((await auditLogs(target.id))[0].changes).toEqual({ accountType: { from: 'staff', to: 'student' } });
  });

  it('เปลี่ยนเป็นบุคลากรภายนอก: ให้ role external เฉพาะบัญชีที่อนุมัติแล้ว', async () => {
    const admin = await superAdmin();
    const approved = await createUser({ accountType: 'student', roles: ['user', 'student'] });
    const pending = await createUser({ accountType: 'student', approvalStatus: 'pending', roles: ['user'] });
    await patch(`/admin/users/${approved.id}`, admin.cookie, { accountType: 'external', reason: 'x' });
    await patch(`/admin/users/${pending.id}`, admin.cookie, { accountType: 'external', reason: 'x' });
    expect(await rolesOf(approved.id)).toEqual(['external', 'user']);
    expect(await rolesOf(pending.id)).toEqual(['user']);
  });

  it('แก้หน่วยงานของนิสิตได้ แต่ของบุคลากรไม่ได้ (มาจาก ERP)', async () => {
    const admin = await superAdmin();
    const student = await createUser({ accountType: 'student' });
    const staff = await createUser({ accountType: 'staff' });
    const unit = await orgUnitId('25');

    const ok = await patch(`/admin/users/${student.id}`, admin.cookie, { orgUnitId: unit, reason: 'x' });
    expect(ok.status).toBe(204);
    expect((await userRow(student.id)).org_unit_code).toBe('25');

    const denied = await patch(`/admin/users/${staff.id}`, admin.cookie, { orgUnitId: unit, reason: 'x' });
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('ORG_UNIT_FROM_ERP');

    const missing = await patch(`/admin/users/${student.id}`, admin.cookie, {
      orgUnitId: crypto.randomUUID(),
      reason: 'x',
    });
    expect(missing.body.error.code).toBe('ORG_UNIT_NOT_FOUND');
  });

  it('ไม่มีอะไรเปลี่ยน → 400, ไม่มีเหตุผล → 400', async () => {
    const admin = await superAdmin();
    const target = await createUser({ accountType: 'staff' });
    const same = await patch(`/admin/users/${target.id}`, admin.cookie, { accountType: 'staff', reason: 'x' });
    expect(same.body.error.code).toBe('NO_CHANGES');
    expect((await patch(`/admin/users/${target.id}`, admin.cookie, { accountType: 'student' })).status).toBe(400);
  });

  it('ต้องมี user:update และห้ามแก้บัญชีของตัวเอง', async () => {
    const reader = await userWithPermissions('user:read');
    const target = await createUser();
    const denied = await patch(`/admin/users/${target.id}`, reader.cookie, { accountType: 'student', reason: 'x' });
    expect(denied.status).toBe(403);

    const admin = await superAdmin();
    const self = await patch(`/admin/users/${admin.id}`, admin.cookie, { displayNameOverride: 'ฉัน', reason: 'x' });
    expect(self.body.error.code).toBe('CANNOT_MANAGE_SELF');
  });

  it('GET /admin/org-units คืนหน่วยงานที่ใช้งานอยู่', async () => {
    const admin = await superAdmin();
    const res = await request(app).get('/admin/org-units').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.orgUnits).toEqual(expect.arrayContaining([expect.objectContaining({ code: '25' })]));
  });
});
