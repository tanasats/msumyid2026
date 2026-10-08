import { PERMISSIONS, SUPER_ADMIN_ROLE, type Permission } from './permissions.js';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: 'student' | 'staff' | 'external';
  approvalStatus: 'pending' | 'approved' | 'rejected';
  roles: string[];
  permissions: string[];
};

export function isSuperAdmin(user: AuthUser): boolean {
  return user.roles.includes(SUPER_ADMIN_ROLE);
}

/**
 * ตรวจสิทธิ์ — จุดเดียวในระบบที่ super_admin ผ่านทุก permission (CLAUDE.md หัวข้อ 9)
 * ผู้ใช้ที่ยังไม่อนุมัติไม่มีสิทธิ์ใดเลย แม้จะถือ role อยู่
 */
export function hasPermission(user: AuthUser, permission: Permission): boolean {
  if (user.approvalStatus !== 'approved') return false;
  if (isSuperAdmin(user)) return true;
  return user.permissions.includes(permission);
}

/** ข้อมูล role ที่ใช้ตัดสินกฎการให้/ถอน */
export type RoleRule = { code: string; isSystem: boolean; isPrivileged: boolean };

export type RoleChangeDenial = 'SELF' | 'SYSTEM_ROLE' | 'PRIVILEGED_ROLE' | 'FORBIDDEN';

/**
 * กฎการให้/ถอน role — ที่เดียวในระบบ (CLAUDE.md หัวข้อ 9)
 * - ห้ามแก้ role ของตัวเอง
 * - role ระบบที่ไม่ใช่สิทธิ์สูง (user/student/staff/external) ระบบจัดการเอง แก้ด้วยมือไม่ได้
 *   (user ถอนไม่ได้, student/staff ให้ตอน login, external ให้ตอนอนุมัติ)
 * - role สิทธิ์สูง (is_privileged รวม super_admin) ให้/ถอนได้เฉพาะ super_admin
 * - role อื่นต้องมี user_role:assign
 * กฎ "ห้ามถอน super_admin คนสุดท้าย" ต้องนับจากฐานข้อมูล จึงตรวจใน user-admin-service
 * คืน null = อนุญาต
 */
export function canGrantRole(actor: AuthUser, targetUserId: string, role: RoleRule): RoleChangeDenial | null {
  if (actor.id === targetUserId) return 'SELF';
  if (role.isSystem && !role.isPrivileged) return 'SYSTEM_ROLE';
  if (role.isPrivileged) return isSuperAdmin(actor) ? null : 'PRIVILEGED_ROLE';
  return hasPermission(actor, PERMISSIONS.USER_ROLE_ASSIGN) ? null : 'FORBIDDEN';
}

export type UserManageDenial = 'SELF' | 'PRIVILEGED_TARGET';

/**
 * กฎการจัดการบัญชีผู้อื่น (ปิด/เปิด, อนุมัติ, แก้ไข, ลบ) — ใช้คู่กับ permission ของแต่ละการกระทำ
 * - ห้ามจัดการบัญชีของตัวเอง (กันปิด/ลบตัวเองจนไม่มีผู้ดูแล)
 * - ผู้ใช้ที่ถือ role สิทธิ์สูง จัดการได้เฉพาะ super_admin (กัน admin ปิดบัญชี super_admin)
 * คืน null = อนุญาต
 */
export function canManageUser(
  actor: AuthUser,
  target: { id: string; hasPrivilegedRole: boolean },
): UserManageDenial | null {
  if (actor.id === target.id) return 'SELF';
  if (target.hasPrivilegedRole && !isSuperAdmin(actor)) return 'PRIVILEGED_TARGET';
  return null;
}
