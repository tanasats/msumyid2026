import { SUPER_ADMIN_ROLE, type Permission } from './permissions.js';

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
