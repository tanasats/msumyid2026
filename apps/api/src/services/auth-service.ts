import { pool } from '../db/pool.js';
import { listPermissionCodes } from '../repositories/permission-repository.js';
import { canManageRoles, canManageSystemSettings, isSuperAdmin, type AuthUser } from './authorization-service.js';

/**
 * งานที่ไม่ได้ควบคุมด้วย permission แต่ใช้กฎใน authorization-service (เช่น super_admin เท่านั้น)
 * ส่งให้ web ซ่อน/แสดงเมนู — web จึงไม่ต้องเช็คชื่อ role เอง
 */
export type Capabilities = {
  /** หน้า /admin/roles (canManageRoles) */
  manageRoles: boolean;
  /** หน้า /admin/settings (canManageSystemSettings) */
  manageSettings: boolean;
};

export type CurrentUser = AuthUser & { capabilities: Capabilities };

/**
 * ข้อมูลผู้ใช้ปัจจุบันสำหรับ GET /auth/me
 * permissions = สิทธิ์ที่ใช้ได้จริง (super_admin ได้ทุก permission ที่ลงทะเบียน) ใช้ให้ web ซ่อน/แสดงเมนูเท่านั้น
 */
export async function getCurrentUser(user: AuthUser): Promise<CurrentUser> {
  const capabilities: Capabilities = { manageRoles: canManageRoles(user), manageSettings: canManageSystemSettings(user) };
  if (user.approvalStatus !== 'approved') {
    return { ...user, permissions: [], capabilities };
  }
  if (isSuperAdmin(user)) {
    return { ...user, permissions: await listPermissionCodes(pool), capabilities };
  }
  return { ...user, capabilities };
}
