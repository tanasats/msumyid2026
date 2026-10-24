import { apiFetch } from './api-server';
import type { RoleAdminOverview } from './role-admin';

/** role ทั้งหมด + permission ทั้งหมด + ประวัติล่าสุด (super_admin เท่านั้น — API ตรวจ) */
export async function getRoleAdminOverview(): Promise<RoleAdminOverview> {
  return apiFetch('/admin/role-permissions');
}
