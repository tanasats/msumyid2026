import { pool } from '../db/pool.js';
import { listPermissionCodes } from '../repositories/permission-repository.js';
import { canManageRoles, canManageSystemSettings, isSuperAdmin, type AuthUser } from './authorization-service.js';
import type { MfaSessionState } from './session-service.js';

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

/** สถานะ MFA ที่ web ใช้เลือกหน้า (/mfa = ใส่รหัส, /mfa/setup = role บังคับแต่ยังไม่ตั้งค่า) */
export type CurrentUserMfa = { enabled: boolean; required: boolean; verified: boolean };

export type CurrentUser = AuthUser & { capabilities: Capabilities; mfa: CurrentUserMfa };

/**
 * ข้อมูลผู้ใช้ปัจจุบันสำหรับ GET /auth/me
 * permissions = สิทธิ์ที่ใช้ได้จริง (super_admin ได้ทุก permission ที่ลงทะเบียน) ใช้ให้ web ซ่อน/แสดงเมนูเท่านั้น
 * ยังไม่ผ่าน MFA ของ session นี้: ไม่คืน role/permission (ผู้ที่ได้ session ไปยังไม่ได้พิสูจน์ปัจจัยที่สอง)
 */
export async function getCurrentUser(user: AuthUser, session: MfaSessionState): Promise<CurrentUser> {
  const mfa: CurrentUserMfa = { enabled: session.enabled, required: session.required, verified: session.verifiedAt !== null };
  const noAccess: Capabilities = { manageRoles: false, manageSettings: false };
  if (mfa.enabled && !mfa.verified) {
    return { ...user, roles: [], permissions: [], capabilities: noAccess, mfa };
  }
  const capabilities: Capabilities = { manageRoles: canManageRoles(user), manageSettings: canManageSystemSettings(user) };
  if (user.approvalStatus !== 'approved') {
    return { ...user, permissions: [], capabilities, mfa };
  }
  if (isSuperAdmin(user)) {
    return { ...user, permissions: await listPermissionCodes(pool), capabilities, mfa };
  }
  return { ...user, capabilities, mfa };
}
