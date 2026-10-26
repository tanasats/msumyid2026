import type { AccountType } from '../repositories/session-repository.js';
import { PERMISSIONS, SUPER_ADMIN_ROLE, type Permission } from './permissions.js';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  /** รับทราบประกาศความเป็นส่วนตัวเวอร์ชันปัจจุบันแล้ว (docs/design/pdpa.md) */
  privacyAcknowledged: boolean;
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
 * - ห้ามแก้ role ของตัวเอง ยกเว้น super_admin (ตัดสินใจ 2026-10-24: super_admin จัดการได้ทุกอย่างรวมของตัวเอง
 *   — ถอน super_admin ของตัวเองได้เมื่อยังเหลือคนอื่น ซึ่งตรวจใน user-admin-service)
 * - role ระบบที่ไม่ใช่สิทธิ์สูง (user/student/staff/external/service) ระบบจัดการเอง แก้ด้วยมือไม่ได้
 *   (user ถอนไม่ได้, student/staff ให้ตอน login, external/service ให้ตอนอนุมัติ)
 * - role สิทธิ์สูง (is_privileged รวม super_admin) ให้/ถอนได้เฉพาะ super_admin
 * - role อื่นต้องมี user_role:assign
 * กฎ "ห้ามถอน super_admin คนสุดท้าย" ต้องนับจากฐานข้อมูล จึงตรวจใน user-admin-service
 * คืน null = อนุญาต
 */
export function canGrantRole(actor: AuthUser, targetUserId: string, role: RoleRule): RoleChangeDenial | null {
  if (actor.id === targetUserId && !isSuperAdmin(actor)) return 'SELF';
  if (role.isSystem && !role.isPrivileged) return 'SYSTEM_ROLE';
  if (role.isPrivileged) return isSuperAdmin(actor) ? null : 'PRIVILEGED_ROLE';
  return hasPermission(actor, PERMISSIONS.USER_ROLE_ASSIGN) ? null : 'FORBIDDEN';
}

export type UserManageDenial = 'SELF' | 'PRIVILEGED_TARGET';

/**
 * กฎการจัดการบัญชีและข้อมูลของผู้ใช้ (ปิด/เปิด, อนุมัติ, แก้ไข, ลบบัญชี, เพิกถอนใบรับรอง, ตัดสินคำขอใบเสริม)
 * ใช้คู่กับ permission ของแต่ละการกระทำ
 * - ห้ามจัดการบัญชีของตัวเอง ยกเว้น super_admin (ตัดสินใจ 2026-10-24) — กฎ "ต้องเหลือ super_admin ที่ใช้งานได้
 *   อย่างน้อย 1 คน" ยังกันการปิด/ลบตัวเองของคนสุดท้าย (ตรวจใน user-admin-service)
 * - ผู้ใช้ที่ถือ role สิทธิ์สูง จัดการได้เฉพาะ super_admin (กัน admin ปิดบัญชี super_admin)
 * คืน null = อนุญาต
 */
export function canManageUser(
  actor: AuthUser,
  target: { id: string; hasPrivilegedRole: boolean },
): UserManageDenial | null {
  if (isSuperAdmin(actor)) return null;
  if (actor.id === target.id) return 'SELF';
  if (target.hasPrivilegedRole && !isSuperAdmin(actor)) return 'PRIVILEGED_TARGET';
  return null;
}

/**
 * กำหนด role และสิทธิ์ของ role (หน้า /admin/roles) — super_admin เท่านั้น (ตัดสินใจ 2026-10-24)
 * ไม่ใช้ permission เพราะถ้าผูก permission นี้ให้ role อื่นได้ ผู้ถือ role นั้นจะเพิ่มสิทธิ์ให้ตัวเองได้ (privilege escalation)
 */
export function canManageRoles(actor: AuthUser): boolean {
  return actor.approvalStatus === 'approved' && isSuperAdmin(actor);
}

/** role ที่ได้ทุก permission อยู่แล้ว (super_admin ผ่าน hasPermission) — ผูก permission เพิ่มไม่มีผล */
export function roleHasAllPermissions(role: { code: string }): boolean {
  return role.code === SUPER_ADMIN_ROLE;
}

/** แก้ค่าตั้งของระบบ (หน้า /admin/settings) — super_admin เท่านั้น ด้วยเหตุผลเดียวกับ canManageRoles */
export function canManageSystemSettings(actor: AuthUser): boolean {
  return actor.approvalStatus === 'approved' && isSuperAdmin(actor);
}
