import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seedInitialSuperAdmin } from '../src/services/super-admin-seed-service.js';
import { createUser, loginAs, resetDatabase } from './helpers/db.js';
import { PERMISSIONS } from '../src/services/permissions.js';

const app = createApp();
const EMAIL = 'admin.first@msu.ac.th';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function superAdminLogs() {
  const { rows } = await pool.query(
    `SELECT l.actor_id, l.target_user_id, l.action, l.reason
     FROM role_change_logs l JOIN roles r ON r.id = l.role_id
     WHERE r.code = 'super_admin'`,
  );
  return rows;
}

describe('seedInitialSuperAdmin', () => {
  it('ยังไม่เคย login → USER_NOT_FOUND', async () => {
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'USER_NOT_FOUND' });
  });

  it('ให้ role super_admin พร้อมเขียน log (ผู้กระทำ = ระบบ)', async () => {
    const user = await createUser({ email: EMAIL, roles: ['user', 'staff'] });

    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: true, status: 'granted', userId: user.id });

    const { rows } = await pool.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
      [user.id],
    );
    expect(rows.map((r) => r.code)).toEqual(['staff', 'super_admin', 'user']);
    expect(await superAdminLogs()).toEqual([
      {
        actor_id: null,
        target_user_id: user.id,
        action: 'grant',
        reason: 'seed ผู้ดูแลระบบสูงสุดคนแรก (INITIAL_SUPER_ADMIN_EMAIL)',
      },
    ]);
  });

  it('รันซ้ำได้: ครั้งที่สองไม่เปลี่ยนอะไรและไม่เขียน log ซ้ำ', async () => {
    const user = await createUser({ email: EMAIL });
    await seedInitialSuperAdmin(EMAIL);
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: true, status: 'already', userId: user.id });
    expect(await superAdminLogs()).toHaveLength(1);
  });

  it('ค้น email แบบไม่สนตัวพิมพ์', async () => {
    const user = await createUser({ email: EMAIL });
    expect(await seedInitialSuperAdmin('Admin.First@MSU.ac.th')).toMatchObject({ ok: true, userId: user.id });
  });

  it('มี super_admin คนอื่นอยู่แล้ว → SUPER_ADMIN_EXISTS (แก้ env เพื่อเพิ่ม super_admin ไม่ได้)', async () => {
    await createUser({ email: 'existing@msu.ac.th', roles: ['user', 'super_admin'] });
    await createUser({ email: EMAIL });
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'SUPER_ADMIN_EXISTS' });
    expect(await superAdminLogs()).toHaveLength(0);
  });

  it('super_admin เดิมถูกลบ (soft delete) แล้ว → seed คนใหม่ได้', async () => {
    const old = await createUser({ email: 'existing@msu.ac.th', roles: ['user', 'super_admin'] });
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [old.id]);
    await createUser({ email: EMAIL });
    expect(await seedInitialSuperAdmin(EMAIL)).toMatchObject({ ok: true, status: 'granted' });
  });

  it('บัญชีรออนุมัติ → NOT_APPROVED', async () => {
    await createUser({ email: EMAIL, accountType: 'external', approvalStatus: 'pending' });
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'NOT_APPROVED' });
  });

  it('บัญชีถูกปฏิเสธ → NOT_APPROVED', async () => {
    await createUser({ email: EMAIL, accountType: 'external', approvalStatus: 'rejected' });
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'NOT_APPROVED' });
  });

  it('บัญชีถูกระงับ → INACTIVE', async () => {
    await createUser({ email: EMAIL, isActive: false });
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'INACTIVE' });
  });

  it('บัญชีถูกลบ (soft delete) → USER_NOT_FOUND', async () => {
    const user = await createUser({ email: EMAIL });
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [user.id]);
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'USER_NOT_FOUND' });
  });

  it('email ซ้ำหลายบัญชี → AMBIGUOUS_EMAIL และไม่ให้ role ใคร', async () => {
    await createUser({ email: EMAIL });
    await createUser({ email: EMAIL });
    expect(await seedInitialSuperAdmin(EMAIL)).toEqual({ ok: false, reason: 'AMBIGUOUS_EMAIL' });
    expect(await superAdminLogs()).toHaveLength(0);
  });

  it('หลัง seed แล้ว /auth/me ได้ permission ทั้งหมดของระบบทันที (ไม่ต้อง login ใหม่)', async () => {
    const user = await createUser({ email: EMAIL });
    const cookie = await loginAs(user.id);
    await seedInitialSuperAdmin(EMAIL);

    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.body.user.roles).toContain('super_admin');
    // ต้องตรงกับ permission ที่ประกาศในโค้ด (ตรวจว่า migration ลงทะเบียนครบด้วย)
    expect([...res.body.user.permissions].sort()).toEqual(Object.values(PERMISSIONS).sort());
  });
});
