import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import {
  findUserDetail,
  insertUserAuditLog,
  listUserHistory,
  listUsers,
  lockManagedUser,
  setApprovalStatus,
  setUserActive,
  updateUserProfile,
  type ListUsersFilter,
  type ManagedUserRow,
  type UserDetailRow,
  type UserHistoryRow,
  type UserListRow,
} from '../repositories/admin-user-repository.js';
import {
  findRoleByCode,
  findUserRolesByCodes,
  grantRoleByActor,
  listRoles,
  lockActiveRoleHolderIds,
  revokeRoleByActor,
  type RoleRow,
} from '../repositories/role-repository.js';
import { findActiveOrgUnit, listActiveOrgUnits, type OrgUnitRow } from '../repositories/org-unit-repository.js';
import { deleteSessionsByUser, type AccountType } from '../repositories/session-repository.js';
import { findStaffProfileByUserId, type StaffProfileRow } from '../repositories/staff-profile-repository.js';
import { canGrantRole, canManageUser, type AuthUser, type RoleChangeDenial } from './authorization-service.js';
import { SUPER_ADMIN_ROLE } from './permissions.js';

// business logic ของหน้าจัดการบัญชีผู้ใช้ — permission ของแต่ละ endpoint ตรวจที่ route (requirePermission)
// ส่วนกฎที่ขึ้นกับผู้ใช้เป้าหมาย (ห้ามทำกับตัวเอง, super_admin คนสุดท้าย ฯลฯ) ตรวจที่นี่

const HISTORY_LIMIT = 30;

export type UserListResult = { users: UserListRow[]; nextCursor: string | null };

export async function searchUsers(filter: ListUsersFilter): Promise<UserListResult> {
  const { rows, nextCursor } = await listUsers(pool, filter);
  return { users: rows, nextCursor };
}

export type UserDetail = {
  user: UserDetailRow;
  staffProfile: StaffProfileRow | null;
  history: UserHistoryRow[];
  /** ผู้ดูแลคนปัจจุบันจัดการบัญชีนี้ได้หรือไม่ (ไม่ใช่ตัวเอง และไม่ติดกฎ role สิทธิ์สูง) — ใช้ซ่อนปุ่มบนหน้าจอเท่านั้น */
  manageable: boolean;
  isSelf: boolean;
};

export async function getUserDetail(actor: AuthUser, userId: string): Promise<UserDetail> {
  const user = await findUserDetail(pool, userId);
  if (!user) throw notFound();
  const [staffProfile, history] = await Promise.all([
    findStaffProfileByUserId(pool, userId),
    listUserHistory(pool, userId, HISTORY_LIMIT),
  ]);
  const hasPrivilegedRole = user.roles.some((r) => r.isPrivileged);
  return {
    user,
    staffProfile,
    history,
    manageable: canManageUser(actor, { id: user.id, hasPrivilegedRole }) === null,
    isSelf: actor.id === user.id,
  };
}

export type AssignableRole = RoleRow & { assignable: boolean };

/** role ทั้งหมด พร้อมบอกว่าผู้ดูแลคนนี้ให้/ถอนได้หรือไม่ (ไม่รวมกฎ "ตัวเอง" ซึ่งขึ้นกับผู้ใช้เป้าหมาย) */
export async function listRolesForActor(actor: AuthUser): Promise<AssignableRole[]> {
  const roles = await listRoles(pool);
  // ใช้ id ที่ไม่ใช่ของ actor เพื่อตรวจเฉพาะกฎของ role
  return roles.map((role) => ({ ...role, assignable: canGrantRole(actor, '', role) === null }));
}

/** ล็อกผู้ใช้เป้าหมายและตรวจกฎการจัดการ (ใช้ร่วมกันทุกการกระทำกับบัญชี) */
async function lockTarget(client: PoolClient, actor: AuthUser, userId: string): Promise<ManagedUserRow> {
  const target = await lockManagedUser(client, userId);
  if (!target) throw notFound();
  const denial = canManageUser(actor, target);
  if (denial === 'SELF') {
    throw new AppError(403, 'CANNOT_MANAGE_SELF', 'ไม่สามารถจัดการบัญชีของตัวเองได้');
  }
  if (denial === 'PRIVILEGED_TARGET') {
    throw new AppError(403, 'PRIVILEGED_TARGET', 'บัญชีผู้ดูแลระบบจัดการได้เฉพาะผู้ดูแลระบบสูงสุด');
  }
  return target;
}

/**
 * ล็อก super_admin ที่ใช้งานได้ทั้งหมด — ต้องเรียก "ก่อน" ล็อกผู้ใช้เป้าหมาย (ลำดับล็อกเดียวกันทุก transaction กัน deadlock)
 * เช่น super_admin 2 คนปิดบัญชีกันเองพร้อมกัน: คนที่สองจะรอ แล้วเห็นว่าเหลือคนเดียว → ถูกปฏิเสธ
 */
function lockActiveSuperAdmins(client: PoolClient): Promise<string[]> {
  return lockActiveRoleHolderIds(client, SUPER_ADMIN_ROLE);
}

/** ต้องเหลือ super_admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ — ใช้ก่อนปิดบัญชีหรือถอน role super_admin */
function assertNotLastSuperAdmin(activeSuperAdminIds: string[], userId: string): void {
  if (activeSuperAdminIds.length === 1 && activeSuperAdminIds[0] === userId) {
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'ต้องมีผู้ดูแลระบบสูงสุดที่ใช้งานได้อย่างน้อย 1 คน');
  }
}

/** ปิดบัญชี: ใช้งานไม่ได้ทันที และเพิกถอน session ทั้งหมดใน transaction เดียวกัน */
export async function deactivateUser(actor: AuthUser, userId: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const superAdminIds = await lockActiveSuperAdmins(client);
    const target = await lockTarget(client, actor, userId);
    if (!target.isActive) throw new AppError(409, 'ALREADY_INACTIVE', 'บัญชีนี้ถูกปิดอยู่แล้ว');
    assertNotLastSuperAdmin(superAdminIds, userId);

    await setUserActive(client, { userId, active: false, actorId: actor.id });
    const revokedSessions = await deleteSessionsByUser(client, userId);
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'deactivate',
      changes: { isActive: { from: true, to: false }, revokedSessions },
      reason,
    });
  });
}

export async function activateUser(actor: AuthUser, userId: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    if (target.isActive) throw new AppError(409, 'ALREADY_ACTIVE', 'บัญชีนี้เปิดใช้งานอยู่แล้ว');

    await setUserActive(client, { userId, active: true, actorId: actor.id });
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'activate',
      changes: { isActive: { from: false, to: true } },
      reason,
    });
  });
}

/**
 * อนุมัติบัญชีบุคลากรภายนอก (รออนุมัติ หรือเคยถูกปฏิเสธ)
 * ให้ role ประเภทบัญชี (external) ตอนอนุมัติ — CLAUDE.md หัวข้อ 9
 */
export async function approveUser(actor: AuthUser, userId: string, reason: string | null): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    if (target.approvalStatus === 'approved') {
      throw new AppError(409, 'ALREADY_APPROVED', 'บัญชีนี้ได้รับอนุมัติแล้ว');
    }

    await setApprovalStatus(client, { userId, status: 'approved', actorId: actor.id });
    const accountRole = await findRoleByCode(client, target.accountType);
    if (accountRole) {
      await grantRoleByActor(client, {
        userId,
        roleId: accountRole.id,
        actorId: actor.id,
        reason: 'ให้อัตโนมัติเมื่ออนุมัติบัญชี',
      });
    }
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'approve',
      changes: { approvalStatus: { from: target.approvalStatus, to: 'approved' } },
      reason,
    });
  });
}

/** ปฏิเสธบัญชีที่รออนุมัติ — ผู้ใช้ยัง login ได้แต่เห็นเฉพาะหน้าแจ้งว่าไม่ได้รับอนุมัติ */
export async function rejectUser(actor: AuthUser, userId: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    if (target.approvalStatus !== 'pending') {
      throw new AppError(409, 'NOT_PENDING', 'ปฏิเสธได้เฉพาะบัญชีที่รออนุมัติ');
    }

    await setApprovalStatus(client, { userId, status: 'rejected', actorId: actor.id });
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'reject',
      changes: { approvalStatus: { from: 'pending', to: 'rejected' } },
      reason,
    });
  });
}

const ROLE_DENIAL_ERRORS: Record<RoleChangeDenial, () => AppError> = {
  SELF: () => new AppError(403, 'CANNOT_MANAGE_SELF', 'ไม่สามารถแก้ role ของตัวเองได้'),
  SYSTEM_ROLE: () => new AppError(409, 'SYSTEM_ROLE', 'role นี้ระบบกำหนดให้อัตโนมัติ แก้ไขเองไม่ได้'),
  PRIVILEGED_ROLE: () => new AppError(403, 'PRIVILEGED_ROLE', 'role สิทธิ์สูงให้หรือถอนได้เฉพาะผู้ดูแลระบบสูงสุด'),
  FORBIDDEN: () => new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้'),
};

/** ตรวจผู้ใช้เป้าหมาย + role + กฎการให้/ถอน แล้วคืน role ที่จะเปลี่ยน */
async function prepareRoleChange(
  client: PoolClient,
  actor: AuthUser,
  userId: string,
  roleCode: string,
): Promise<RoleRow> {
  // ล็อกผู้ใช้เป้าหมายเพื่อให้การเปลี่ยน role ของคนเดียวกันทำทีละรายการ
  const target = await lockManagedUser(client, userId);
  if (!target) throw notFound();
  const role = await findRoleByCode(client, roleCode);
  if (!role) throw new AppError(404, 'ROLE_NOT_FOUND', 'ไม่พบ role ที่ระบุ');
  const denial = canGrantRole(actor, userId, role);
  if (denial) throw ROLE_DENIAL_ERRORS[denial]();
  return role;
}

export async function grantRole(actor: AuthUser, userId: string, roleCode: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const role = await prepareRoleChange(client, actor, userId, roleCode);
    const granted = await grantRoleByActor(client, { userId, roleId: role.id, actorId: actor.id, reason });
    if (!granted) throw new AppError(409, 'ROLE_ALREADY_GRANTED', 'ผู้ใช้มี role นี้อยู่แล้ว');
  });
}

export async function revokeRole(actor: AuthUser, userId: string, roleCode: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const superAdminIds = roleCode === SUPER_ADMIN_ROLE ? await lockActiveSuperAdmins(client) : null;
    const role = await prepareRoleChange(client, actor, userId, roleCode);
    if (superAdminIds) assertNotLastSuperAdmin(superAdminIds, userId);
    const revoked = await revokeRoleByActor(client, { userId, roleId: role.id, actorId: actor.id, reason });
    if (!revoked) throw new AppError(409, 'ROLE_NOT_GRANTED', 'ผู้ใช้ไม่มี role นี้');
  });
}

function notFound(): AppError {
  return new AppError(404, 'USER_NOT_FOUND', 'ไม่พบผู้ใช้');
}

export function listOrgUnits(): Promise<OrgUnitRow[]> {
  return listActiveOrgUnits(pool);
}

export type UpdateUserInput = {
  /** undefined = ไม่แก้, null = ล้าง (กลับไปใช้ชื่อจาก ERP/Google) */
  displayNameOverride?: string | null;
  accountType?: AccountType;
  /** undefined = ไม่แก้, null = ไม่ระบุหน่วยงาน */
  orgUnitId?: string | null;
};

// role ประเภทบัญชี — code ตรงกับค่า account_type (แบบเดียวกับที่ระบบให้ตอน login)
const ACCOUNT_TYPE_ROLES: AccountType[] = ['student', 'staff', 'external'];

/**
 * แก้ไขข้อมูลผู้ใช้ (ชื่อแสดง, ประเภทบัญชี, หน่วยงาน) — เฉพาะช่องที่ส่งมาและค่าเปลี่ยนจริง
 * - หน่วยงานของบุคลากรมาจาก ERP ทุกครั้งที่ login จึงแก้เองไม่ได้
 * - เปลี่ยนประเภทบัญชี → ถอน role ประเภทเดิม ให้ role ประเภทใหม่ (external ให้เมื่ออนุมัติแล้วเท่านั้น)
 * - audit log ไม่บันทึกค่าชื่อ (PDPA) บันทึกแค่ว่าเปลี่ยน
 */
export async function updateUser(
  actor: AuthUser,
  userId: string,
  input: UpdateUserInput,
  reason: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    const changes: Record<string, unknown> = {};
    const nextAccountType = input.accountType ?? target.accountType;

    const displayNameChanged =
      input.displayNameOverride !== undefined && input.displayNameOverride !== target.displayNameOverride;
    if (displayNameChanged) {
      changes.displayName = input.displayNameOverride === null ? 'reset' : 'changed';
    }

    const accountTypeChanged = input.accountType !== undefined && input.accountType !== target.accountType;
    if (accountTypeChanged) {
      changes.accountType = { from: target.accountType, to: input.accountType };
    }

    const orgUnitChanged = input.orgUnitId !== undefined && input.orgUnitId !== target.orgUnitId;
    if (orgUnitChanged) {
      if (nextAccountType === 'staff') {
        throw new AppError(409, 'ORG_UNIT_FROM_ERP', 'หน่วยงานของบุคลากรมาจากระบบ ERP แก้ไขเองไม่ได้');
      }
      if (input.orgUnitId && !(await findActiveOrgUnit(client, input.orgUnitId))) {
        throw new AppError(400, 'ORG_UNIT_NOT_FOUND', 'ไม่พบหน่วยงานที่เลือก');
      }
      changes.orgUnitId = { from: target.orgUnitId, to: input.orgUnitId };
    }

    if (Object.keys(changes).length === 0) {
      throw new AppError(400, 'NO_CHANGES', 'ไม่มีข้อมูลที่เปลี่ยนแปลง');
    }

    await updateUserProfile(client, {
      userId,
      displayNameOverride: displayNameChanged ? input.displayNameOverride : undefined,
      accountType: accountTypeChanged ? input.accountType : undefined,
      orgUnitId: orgUnitChanged ? input.orgUnitId : undefined,
    });

    if (accountTypeChanged) {
      const roleReason = `เปลี่ยนประเภทบัญชี: ${reason}`;
      const heldAccountRoles = await findUserRolesByCodes(client, userId, ACCOUNT_TYPE_ROLES);
      for (const role of heldAccountRoles.filter((r) => r.code !== nextAccountType)) {
        await revokeRoleByActor(client, { userId, roleId: role.id, actorId: actor.id, reason: roleReason });
      }
      if (nextAccountType !== 'external' || target.approvalStatus === 'approved') {
        const newRole = await findRoleByCode(client, nextAccountType);
        if (newRole) {
          await grantRoleByActor(client, { userId, roleId: newRole.id, actorId: actor.id, reason: roleReason });
        }
      }
    }

    await insertUserAuditLog(client, { actorId: actor.id, targetUserId: userId, action: 'update', changes, reason });
  });
}
