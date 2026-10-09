import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// ลบบัญชีและข้อมูลส่วนบุคคล (ระยะ 3) — ฐานข้อมูลจริง app_test (CLAUDE.md หัวข้อ 15)

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

function deleteUser(id: string, cookie: string, body: object) {
  return request(app).delete(`/admin/users/${id}`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
}

async function rawUser(id: string) {
  const { rows } = await pool.query(
    `SELECT google_sub, email, name, display_name, display_name_override, picture_url, org_unit_id,
            is_active, deleted_at IS NOT NULL AS deleted
     FROM users WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe('DELETE /admin/users/:id', () => {
  it('ลบข้อมูลส่วนบุคคล: ตัดชื่อ/อีเมล/รูป/google_sub ลบข้อมูลบุคลากร ถอน role และเพิกถอน session', async () => {
    const admin = await superAdmin();
    const target = await createUser({ email: 'somchai.j@msu.ac.th', name: 'สมชาย ใจดี', roles: ['user', 'staff'] });
    const targetCookie = await loginAs(target.id);
    await pool.query(
      `UPDATE users SET picture_url = 'https://example.com/p.jpg', display_name_override = 'ชื่อตั้งเอง',
              org_unit_id = (SELECT id FROM org_units WHERE code = '25') WHERE id = $1`,
      [target.id],
    );
    await pool.query(
      `INSERT INTO staff_profiles (user_id, staff_id, first_name_th, last_name_th, synced_at)
       VALUES ($1, '1234567', 'สมชาย', 'ใจดี', now())`,
      [target.id],
    );

    const res = await deleteUser(target.id, admin.cookie, {
      confirmEmail: 'SOMCHAI.J@msu.ac.th',
      reason: 'คำขอลบข้อมูลผ่าน DPO',
    });
    expect(res.status).toBe(204);

    expect(await rawUser(target.id)).toEqual({
      google_sub: null,
      email: `deleted-${target.id}@deleted.invalid`,
      name: 'ผู้ใช้ที่ถูกลบ',
      display_name: 'ผู้ใช้ที่ถูกลบ',
      display_name_override: null,
      picture_url: null,
      org_unit_id: null,
      is_active: false,
      deleted: true,
    });
    const profiles = await pool.query(`SELECT 1 FROM staff_profiles WHERE user_id = $1`, [target.id]);
    expect(profiles.rows).toHaveLength(0);
    const roles = await pool.query(`SELECT 1 FROM user_roles WHERE user_id = $1`, [target.id]);
    expect(roles.rows).toHaveLength(0);
    expect((await request(app).get('/auth/me').set('Cookie', targetCookie)).status).toBe(401);

    // ถอน role ทุกตัวพร้อม log
    const roleLogs = await pool.query(
      `SELECT action, reason FROM role_change_logs WHERE target_user_id = $1 AND actor_id = $2`,
      [target.id, admin.id],
    );
    expect(roleLogs.rows).toHaveLength(2);
    expect(roleLogs.rows.every((r) => r.action === 'revoke' && r.reason === 'ลบบัญชี: คำขอลบข้อมูลผ่าน DPO')).toBe(true);

    // audit log ไม่มีข้อมูลส่วนบุคคลของผู้ใช้ที่ถูกลบ
    const audit = await pool.query(`SELECT action, changes FROM user_audit_logs WHERE target_user_id = $1`, [
      target.id,
    ]);
    expect(audit.rows).toEqual([
      { action: 'delete', changes: { personalData: 'deleted', revokedSessions: 1, revokedRoles: 2, revokedCertificates: 0, erasedCertificates: 0, deletedKeyEscrows: 0 } },
    ]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/somchai|สมชาย/i);
  });

  it('หลังลบ: ไม่พบในรายการและหน้ารายละเอียด', async () => {
    const admin = await superAdmin();
    const target = await createUser({ email: 'gone@msu.ac.th' });
    await deleteUser(target.id, admin.cookie, { confirmEmail: 'gone@msu.ac.th', reason: 'x' });

    expect((await request(app).get(`/admin/users/${target.id}`).set('Cookie', admin.cookie)).status).toBe(404);
    const list = await request(app).get('/admin/users').set('Cookie', admin.cookie);
    expect(list.body.users.map((u: { id: string }) => u.id)).toEqual([admin.id]);
    // ลบซ้ำ → ไม่พบ
    const again = await deleteUser(target.id, admin.cookie, { confirmEmail: 'x', reason: 'x' });
    expect(again.status).toBe(404);
  });

  it('เจ้าของบัญชีกลับมา login ด้วย Google เดิม → ได้บัญชีใหม่ (ไม่ได้ข้อมูลหรือสิทธิ์เดิมคืน)', async () => {
    const admin = await superAdmin();
    const sub = 'google-returning-user';
    await google.loginWith(app, { sub, email: 'back@msu.ac.th' });
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM users WHERE google_sub = $1`, [sub]);
    const oldId = rows[0]!.id;
    await deleteUser(oldId, admin.cookie, { confirmEmail: 'back@msu.ac.th', reason: 'x' });

    const { res } = await google.loginWith(app, { sub, email: 'back@msu.ac.th' });
    expect(google.sessionCookieFrom(res)).toBeDefined();
    const after = await pool.query<{ id: string }>(`SELECT id FROM users WHERE google_sub = $1`, [sub]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.id).not.toBe(oldId);
  });

  it('อีเมลยืนยันไม่ตรง → 400 และไม่มีอะไรถูกลบ', async () => {
    const admin = await superAdmin();
    const target = await createUser({ email: 'keep@msu.ac.th' });
    const res = await deleteUser(target.id, admin.cookie, { confirmEmail: 'other@msu.ac.th', reason: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EMAIL_MISMATCH');
    expect(await rawUser(target.id)).toMatchObject({ email: 'keep@msu.ac.th', deleted: false });
  });

  it('ต้องระบุอีเมลยืนยันและเหตุผล', async () => {
    const admin = await superAdmin();
    const target = await createUser({ email: 'keep@msu.ac.th' });
    expect((await deleteUser(target.id, admin.cookie, { reason: 'x' })).status).toBe(400);
    expect((await deleteUser(target.id, admin.cookie, { confirmEmail: 'keep@msu.ac.th' })).status).toBe(400);
  });

  it('ต้องมี user:delete, ห้ามลบตัวเอง, บัญชีผู้ดูแลลบได้เฉพาะ super_admin', async () => {
    await createTestRole('test_operator', ['user:deactivate']);
    const deactivator = await createUser({ roles: ['user', 'test_operator'] });
    const target = await createUser({ email: 't@msu.ac.th' });
    const denied = await deleteUser(target.id, await loginAs(deactivator.id), { confirmEmail: 't@msu.ac.th', reason: 'x' });
    expect(denied.status).toBe(403);

    const admin = await superAdmin();
    const self = await deleteUser(admin.id, admin.cookie, { confirmEmail: 'x', reason: 'x' });
    expect(self.body.error.code).toBe('CANNOT_MANAGE_SELF');

    await createTestRole('test_deleter', ['user:delete']);
    const deleter = await createUser({ roles: ['user', 'test_deleter'] });
    const privileged = await createUser({ email: 'adm@msu.ac.th', roles: ['user', 'admin'] });
    const res = await deleteUser(privileged.id, await loginAs(deleter.id), { confirmEmail: 'adm@msu.ac.th', reason: 'x' });
    expect(res.body.error.code).toBe('PRIVILEGED_TARGET');
  });
});
