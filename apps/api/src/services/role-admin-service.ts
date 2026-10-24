import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { listPermissions, type PermissionRow } from '../repositories/permission-repository.js';
import {
  deleteRolePermission,
  insertRole,
  insertRolePermission,
  insertRolePermissionLog,
  listRolePermissionCodes,
  listRolePermissionLogs,
  listRolesWithAccess,
  lockRoleByCode,
  updateRoleName,
  type RolePermissionLog,
  type RoleWithAccess,
} from '../repositories/role-repository.js';
import { canManageRoles, roleHasAllPermissions, type AuthUser } from './authorization-service.js';

// กำหนด role และสิทธิ์ของ role (หน้า /admin/roles) — super_admin เท่านั้น (canManageRoles)
// นักพัฒนาประกาศ permission ผ่าน migration ส่วน super_admin สร้าง role และผูก permission ที่นี่ (CLAUDE.md หัวข้อ 9)
// สิทธิ์มีผลทันที: ทุก request อ่าน permission ของผู้ใช้จากฐานข้อมูลใหม่ (session-repository)

const LOG_LIMIT = 30;

function assertCanManageRoles(actor: AuthUser): void {
  if (!canManageRoles(actor)) throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
}

export async function getRoleAdminOverview(actor: AuthUser): Promise<{
  roles: RoleWithAccess[];
  permissions: Omit<PermissionRow, 'id'>[];
  logs: RolePermissionLog[];
}> {
  assertCanManageRoles(actor);
  const [roles, permissions, logs] = await Promise.all([
    listRolesWithAccess(pool),
    listPermissions(pool),
    listRolePermissionLogs(pool, LOG_LIMIT),
  ]);
  return { roles, permissions: permissions.map((p) => ({ code: p.code, descriptionTh: p.descriptionTh })), logs };
}

/** สร้าง role ใหม่ (ไม่ใช่ role ระบบ) — is_privileged กำหนดตอนสร้างเท่านั้น (ผู้ถือ role สิทธิ์สูงจัดการได้เฉพาะ super_admin) */
export async function createRole(
  actor: AuthUser,
  input: { code: string; nameTh: string; isPrivileged: boolean; reason: string },
): Promise<void> {
  assertCanManageRoles(actor);
  await withTransaction(async (client) => {
    const created = await insertRole(client, input);
    if (!created) throw new AppError(409, 'ROLE_CODE_EXISTS', `มี role รหัส ${input.code} อยู่แล้ว`);
    await insertRolePermissionLog(client, {
      actorId: actor.id,
      roleId: created.id,
      action: 'create',
      detail: { code: input.code, nameTh: input.nameTh, isPrivileged: input.isPrivileged },
      reason: input.reason,
    });
  });
}

/** เปลี่ยนชื่อไทยของ role (รวม role ระบบ — code เปลี่ยนไม่ได้เพราะโค้ดและ trigger อ้างอิง) */
export async function renameRole(actor: AuthUser, code: string, input: { nameTh: string; reason: string }): Promise<void> {
  assertCanManageRoles(actor);
  await withTransaction(async (client) => {
    const role = await lockRoleByCode(client, code);
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'ไม่พบ role ที่ระบุ');
    if (role.nameTh === input.nameTh) throw new AppError(400, 'NO_CHANGES', 'ชื่อเหมือนเดิม ไม่มีอะไรเปลี่ยน');
    await updateRoleName(client, { id: role.id, nameTh: input.nameTh });
    await insertRolePermissionLog(client, {
      actorId: actor.id,
      roleId: role.id,
      action: 'rename',
      detail: { from: role.nameTh, to: input.nameTh },
      reason: input.reason,
    });
  });
}

/**
 * กำหนดชุด permission ของ role ทั้งชุด — เทียบกับของเดิมแล้วผูก/ถอนเฉพาะที่ต่าง พร้อม log ทีละรายการ ใน transaction เดียว
 * ล็อกแถว role ก่อน: ผู้ดูแล 2 คนแก้ role เดียวกันพร้อมกันจะทำทีละคน (diff และ log ถูกต้อง)
 * super_admin ผ่านทุก permission อยู่แล้ว (hasPermission) ผูกเพิ่มจึงไม่มีผล — ปฏิเสธเพื่อไม่ให้เข้าใจผิด
 */
export async function setRolePermissions(
  actor: AuthUser,
  code: string,
  input: { permissions: string[]; reason: string },
): Promise<{ granted: string[]; revoked: string[] }> {
  assertCanManageRoles(actor);
  return withTransaction(async (client) => {
    const role = await lockRoleByCode(client, code);
    if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'ไม่พบ role ที่ระบุ');
    if (roleHasAllPermissions(role)) {
      throw new AppError(409, 'SUPER_ADMIN_HAS_ALL', 'ผู้ดูแลระบบสูงสุดได้รับทุกสิทธิ์อยู่แล้ว ไม่ต้องกำหนด');
    }

    const all = await listPermissions(client);
    const byCode = new Map(all.map((p) => [p.code, p]));
    const unknown = input.permissions.filter((p) => !byCode.has(p));
    if (unknown.length > 0) {
      throw new AppError(422, 'PERMISSION_NOT_FOUND', `ไม่พบ permission: ${unknown.join(', ')}`);
    }

    const current = new Set(await listRolePermissionCodes(client, role.id));
    const wanted = new Set(input.permissions);
    const granted = [...wanted].filter((p) => !current.has(p)).sort();
    const revoked = [...current].filter((p) => !wanted.has(p)).sort();
    if (granted.length === 0 && revoked.length === 0) {
      throw new AppError(400, 'NO_CHANGES', 'สิทธิ์เหมือนเดิม ไม่มีอะไรเปลี่ยน');
    }

    for (const permissionCode of granted) {
      const permissionId = byCode.get(permissionCode)!.id;
      await insertRolePermission(client, { roleId: role.id, permissionId });
      await insertRolePermissionLog(client, { actorId: actor.id, roleId: role.id, permissionId, action: 'grant', reason: input.reason });
    }
    for (const permissionCode of revoked) {
      const permissionId = byCode.get(permissionCode)!.id;
      await deleteRolePermission(client, { roleId: role.id, permissionId });
      await insertRolePermissionLog(client, { actorId: actor.id, roleId: role.id, permissionId, action: 'revoke', reason: input.reason });
    }
    return { granted, revoked };
  });
}
