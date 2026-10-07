import { pool } from '../db/pool.js';
import { listPermissionCodes } from '../repositories/permission-repository.js';
import { isSuperAdmin, type AuthUser } from './authorization-service.js';

export type CurrentUser = AuthUser;

/**
 * ข้อมูลผู้ใช้ปัจจุบันสำหรับ GET /auth/me
 * permissions = สิทธิ์ที่ใช้ได้จริง (super_admin ได้ทุก permission ที่ลงทะเบียน) ใช้ให้ web ซ่อน/แสดงเมนูเท่านั้น
 */
export async function getCurrentUser(user: AuthUser): Promise<CurrentUser> {
  if (user.approvalStatus !== 'approved') {
    return { ...user, permissions: [] };
  }
  if (isSuperAdmin(user)) {
    return { ...user, permissions: await listPermissionCodes(pool) };
  }
  return user;
}
