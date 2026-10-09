import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import {
  findResponsibleCandidate,
  findUserDetail,
  insertUserAuditLog,
  listUserHistory,
  listUsers,
  lockManagedUser,
  setApprovalStatus,
  anonymizeUser,
  insertPreRegisteredUser,
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
  revokeAllRolesByActor,
  revokeRoleByActor,
  type RoleRow,
} from '../repositories/role-repository.js';
import { findActiveOrgUnit, listActiveOrgUnits, type OrgUnitRow } from '../repositories/org-unit-repository.js';
import { deleteSessionsByUser, type AccountType } from '../repositories/session-repository.js';
import { findUsersByEmail } from '../repositories/user-repository.js';
import { deleteStaffProfile, findStaffProfileByUserId, type StaffProfileRow } from '../repositories/staff-profile-repository.js';
import { erasePersonalDataFromCertificates } from '../repositories/certificate-repository.js';
import { canGrantRole, canManageUser, type AuthUser, type RoleChangeDenial } from './authorization-service.js';
import { revokeCertificatesOfClosedAccount } from './certificate-service.js';
import { issueCrlSafely } from './crl-service.js';
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

// ---- บัญชีหน่วยงาน (account_type = 'service') ----
// บัญชีที่ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม — ต้องมีหน่วยงานและผู้รับผิดชอบ (บุคลากรตัวจริง) ก่อนใช้งาน
// และกำหนดวันหมดอายุได้ (ถึงเวลาแล้วระบบปิดบัญชีเอง — account-expiry-service)

const SERVICE_ONLY_FIELD_ERROR = () =>
  new AppError(409, 'SERVICE_ONLY_FIELD', 'วันหมดอายุและผู้รับผิดชอบใช้ได้เฉพาะบัญชีหน่วยงาน');

/** ผู้รับผิดชอบต้องเป็นบุคลากรที่อนุมัติแล้วและใช้งานได้ และไม่ใช่บัญชีหน่วยงานนั้นเอง */
async function assertValidResponsible(client: PoolClient, responsibleUserId: string, targetUserId: string | null) {
  const candidate = responsibleUserId === targetUserId ? null : await findResponsibleCandidate(client, responsibleUserId);
  if (
    !candidate ||
    candidate.accountType !== 'staff' ||
    candidate.approvalStatus !== 'approved' ||
    !candidate.isActive
  ) {
    throw new AppError(400, 'RESPONSIBLE_INVALID', 'ผู้รับผิดชอบต้องเป็นบุคลากรที่ใช้งานได้');
  }
}

function assertFutureExpiry(expiresAt: Date): void {
  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, 'EXPIRY_IN_PAST', 'วันหมดอายุต้องเป็นเวลาในอนาคต');
  }
}

/** บัญชีหน่วยงานที่ใช้งาน (อนุมัติแล้ว) ต้องมีหน่วยงานและผู้รับผิดชอบเสมอ */
function assertServiceAccountComplete(orgUnitId: string | null, responsibleUserId: string | null): void {
  if (!orgUnitId) {
    throw new AppError(409, 'SERVICE_ORG_UNIT_REQUIRED', 'บัญชีหน่วยงานต้องกำหนดหน่วยงาน');
  }
  if (!responsibleUserId) {
    throw new AppError(409, 'SERVICE_RESPONSIBLE_REQUIRED', 'บัญชีหน่วยงานต้องกำหนดผู้รับผิดชอบ');
  }
}

/**
 * ปิดบัญชี: ใช้งานไม่ได้ทันที เพิกถอน session ทั้งหมด และเพิกถอนใบรับรองที่ใช้งานอยู่ (ถาวร — เปิดบัญชีคืนแล้วต้องขอใบใหม่)
 * ทั้งหมดใน transaction เดียวกัน แล้วออก CRL หลัง commit
 */
export async function deactivateUser(actor: AuthUser, userId: string, reason: string): Promise<void> {
  const revokedCertificates = await withTransaction(async (client) => {
    const superAdminIds = await lockActiveSuperAdmins(client);
    const target = await lockTarget(client, actor, userId);
    if (!target.isActive) throw new AppError(409, 'ALREADY_INACTIVE', 'บัญชีนี้ถูกปิดอยู่แล้ว');
    assertNotLastSuperAdmin(superAdminIds, userId);

    await setUserActive(client, { userId, active: false, actorId: actor.id });
    const revokedSessions = await deleteSessionsByUser(client, userId);
    const revoked = await revokeCertificatesOfClosedAccount(client, { userId, actorId: actor.id, note: `ปิดบัญชี: ${reason}` });
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'deactivate',
      changes: { isActive: { from: true, to: false }, revokedSessions, revokedCertificates: revoked },
      reason,
    });
    return revoked;
  });
  if (revokedCertificates > 0) await issueCrlSafely();
}

export async function activateUser(actor: AuthUser, userId: string, reason: string): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    if (target.isActive) throw new AppError(409, 'ALREADY_ACTIVE', 'บัญชีนี้เปิดใช้งานอยู่แล้ว');
    // ไม่เช่นนั้นจะถูกตัดสิทธิ์และปิดซ้ำทันที
    if (target.accountExpiresAt && target.accountExpiresAt.getTime() <= Date.now()) {
      throw new AppError(409, 'ACCOUNT_EXPIRED', 'บัญชีหมดอายุแล้ว กรุณาขยายวันหมดอายุก่อนเปิดบัญชี');
    }

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
 * อนุมัติบัญชีบุคลากรภายนอกหรือบัญชีหน่วยงาน (รออนุมัติ หรือเคยถูกปฏิเสธ)
 * - ให้ role ประเภทบัญชี (external/service) ตอนอนุมัติ — CLAUDE.md หัวข้อ 9
 * - บัญชีหน่วยงานต้องกำหนดหน่วยงานและผู้รับผิดชอบก่อน (ตรวจผู้รับผิดชอบซ้ำ เพราะอาจถูกปิดบัญชีไปแล้ว)
 */
export async function approveUser(actor: AuthUser, userId: string, reason: string | null): Promise<void> {
  await withTransaction(async (client) => {
    const target = await lockTarget(client, actor, userId);
    if (target.approvalStatus === 'approved') {
      throw new AppError(409, 'ALREADY_APPROVED', 'บัญชีนี้ได้รับอนุมัติแล้ว');
    }
    if (target.accountType === 'service') {
      assertServiceAccountComplete(target.orgUnitId, target.responsibleUserId);
      await assertValidResponsible(client, target.responsibleUserId!, userId);
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
  /** undefined = ไม่แก้, null = ไม่หมดอายุ (เฉพาะบัญชีหน่วยงาน) */
  accountExpiresAt?: Date | null;
  /** undefined = ไม่แก้, null = ล้าง (เฉพาะบัญชีหน่วยงาน) */
  responsibleUserId?: string | null;
};

// role ประเภทบัญชี — code ตรงกับค่า account_type (แบบเดียวกับที่ระบบให้ตอน login)
const ACCOUNT_TYPE_ROLES: AccountType[] = ['student', 'staff', 'external', 'service'];

// ประเภทบัญชีที่ได้ role ประเภทเมื่ออนุมัติแล้วเท่านั้น
const APPROVAL_GRANTED_TYPES: AccountType[] = ['external', 'service'];

const toIso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * แก้ไขข้อมูลผู้ใช้ (ชื่อแสดง, ประเภทบัญชี, หน่วยงาน) — เฉพาะช่องที่ส่งมาและค่าเปลี่ยนจริง
 * - หน่วยงานของบุคลากรมาจาก ERP ทุกครั้งที่ login จึงแก้เองไม่ได้
 * - เปลี่ยนประเภทบัญชี → ถอน role ประเภทเดิม ให้ role ประเภทใหม่ (external/service ให้เมื่ออนุมัติแล้วเท่านั้น)
 * - วันหมดอายุ/ผู้รับผิดชอบใช้ได้เฉพาะบัญชีหน่วยงาน เปลี่ยนเป็นประเภทอื่นแล้วระบบล้างให้
 * - บัญชีหน่วยงานที่อนุมัติแล้วต้องมีหน่วยงานและผู้รับผิดชอบเสมอ
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

    const isService = nextAccountType === 'service';
    if (!isService && (input.accountExpiresAt || input.responsibleUserId)) throw SERVICE_ONLY_FIELD_ERROR();
    // เปลี่ยนจากบัญชีหน่วยงานเป็นประเภทอื่น → ล้างวันหมดอายุและผู้รับผิดชอบ
    const nextExpiresAt = isService
      ? input.accountExpiresAt !== undefined ? input.accountExpiresAt : target.accountExpiresAt
      : null;
    const nextResponsibleId = isService
      ? input.responsibleUserId !== undefined ? input.responsibleUserId : target.responsibleUserId
      : null;

    const expiryChanged = toIso(nextExpiresAt) !== toIso(target.accountExpiresAt);
    if (expiryChanged) {
      if (nextExpiresAt) assertFutureExpiry(nextExpiresAt);
      changes.accountExpiresAt = { from: toIso(target.accountExpiresAt), to: toIso(nextExpiresAt) };
    }
    const responsibleChanged = nextResponsibleId !== target.responsibleUserId;
    if (responsibleChanged) {
      if (nextResponsibleId) await assertValidResponsible(client, nextResponsibleId, userId);
      changes.responsibleUserId = { from: target.responsibleUserId, to: nextResponsibleId };
    }
    if (isService && target.approvalStatus === 'approved') {
      assertServiceAccountComplete(orgUnitChanged ? (input.orgUnitId ?? null) : target.orgUnitId, nextResponsibleId);
    }

    if (Object.keys(changes).length === 0) {
      throw new AppError(400, 'NO_CHANGES', 'ไม่มีข้อมูลที่เปลี่ยนแปลง');
    }

    await updateUserProfile(client, {
      userId,
      displayNameOverride: displayNameChanged ? input.displayNameOverride : undefined,
      accountType: accountTypeChanged ? input.accountType : undefined,
      orgUnitId: orgUnitChanged ? input.orgUnitId : undefined,
      accountExpiresAt: expiryChanged ? nextExpiresAt : undefined,
      responsibleUserId: responsibleChanged ? nextResponsibleId : undefined,
    });

    if (accountTypeChanged) {
      const roleReason = `เปลี่ยนประเภทบัญชี: ${reason}`;
      const heldAccountRoles = await findUserRolesByCodes(client, userId, ACCOUNT_TYPE_ROLES);
      for (const role of heldAccountRoles.filter((r) => r.code !== nextAccountType)) {
        await revokeRoleByActor(client, { userId, roleId: role.id, actorId: actor.id, reason: roleReason });
      }
      if (!APPROVAL_GRANTED_TYPES.includes(nextAccountType) || target.approvalStatus === 'approved') {
        const newRole = await findRoleByCode(client, nextAccountType);
        if (newRole) {
          await grantRoleByActor(client, { userId, roleId: newRole.id, actorId: actor.id, reason: roleReason });
        }
      }
    }

    await insertUserAuditLog(client, { actorId: actor.id, targetUserId: userId, action: 'update', changes, reason });
  });
}

/**
 * ลบบัญชีและข้อมูลส่วนบุคคล (ย้อนกลับไม่ได้) — ใช้กับคำขอลบข้อมูลตาม PDPA หรือบัญชีที่สร้างผิด
 * งานปกติให้ใช้ "ปิดบัญชี" แทน
 * - ต้องพิมพ์อีเมลของผู้ใช้ยืนยัน (กันลบผิดคน)
 * - ทำทั้งหมดใน transaction เดียว: เพิกถอน session, ลบข้อมูลบุคลากร, ถอนทุก role, ตัดข้อมูลส่วนบุคคล, เขียน log
 * - log ไม่เก็บข้อมูลส่วนบุคคล (อีเมล/ชื่อ) ของผู้ใช้ที่ถูกลบ
 */
export async function deleteUser(
  actor: AuthUser,
  userId: string,
  confirmEmail: string,
  reason: string,
): Promise<void> {
  const revokedCertificates = await withTransaction(async (client) => {
    const superAdminIds = await lockActiveSuperAdmins(client);
    const target = await lockTarget(client, actor, userId);
    if (target.email.toLowerCase() !== confirmEmail.trim().toLowerCase()) {
      throw new AppError(400, 'EMAIL_MISMATCH', 'อีเมลที่พิมพ์ยืนยันไม่ตรงกับบัญชีนี้');
    }
    assertNotLastSuperAdmin(superAdminIds, userId);

    const revokedSessions = await deleteSessionsByUser(client, userId);
    await deleteStaffProfile(client, userId);
    const revokedRoles = await revokeAllRolesByActor(client, {
      userId,
      actorId: actor.id,
      reason: `ลบบัญชี: ${reason}`,
    });
    // ใบรับรอง: เพิกถอนใบที่ใช้งานอยู่ก่อน แล้วลบชื่อ/อีเมล/key สำรอง (คง serial และการเพิกถอนไว้ให้ CRL)
    const revoked = await revokeCertificatesOfClosedAccount(client, { userId, actorId: actor.id, note: 'ลบบัญชี' });
    const erased = await erasePersonalDataFromCertificates(client, userId);
    await anonymizeUser(client, { userId, actorId: actor.id });
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'delete',
      changes: {
        personalData: 'deleted',
        revokedSessions,
        revokedRoles,
        revokedCertificates: revoked,
        erasedCertificates: erased.certificates,
        deletedKeyEscrows: erased.keyEscrows,
      },
      reason,
    });
    return revoked;
  });
  if (revokedCertificates > 0) await issueCrlSafely();
}

export type PreRegisterInput = {
  email: string;
  name: string;
  accountType: AccountType;
  orgUnitId: string | null;
  /** เฉพาะบัญชีหน่วยงาน — null = ไม่หมดอายุ */
  accountExpiresAt: Date | null;
  /** เฉพาะบัญชีหน่วยงาน (บังคับ) */
  responsibleUserId: string | null;
};

/** error ของ PostgreSQL เมื่อชนเงื่อนไข UNIQUE */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * ลงทะเบียนผู้ใช้ล่วงหน้าด้วยอีเมล — บัญชีอนุมัติแล้วและได้ role ประเภทบัญชีทันที
 * จะผูกกับบัญชี Google ตอนเจ้าของอีเมล login ครั้งแรก (google-login-service)
 * บัญชีหน่วยงานต้องระบุหน่วยงานและผู้รับผิดชอบ (เพราะถือว่าอนุมัติแล้ว)
 */
export async function preRegisterUser(
  actor: AuthUser,
  input: PreRegisterInput,
  reason: string | null,
): Promise<{ id: string }> {
  return withTransaction(async (client) => {
    if (input.accountType === 'service') {
      assertServiceAccountComplete(input.orgUnitId, input.responsibleUserId);
      await assertValidResponsible(client, input.responsibleUserId!, null);
      if (input.accountExpiresAt) assertFutureExpiry(input.accountExpiresAt);
    } else if (input.accountExpiresAt || input.responsibleUserId) {
      throw SERVICE_ONLY_FIELD_ERROR();
    }
    if (input.orgUnitId) {
      if (input.accountType === 'staff') {
        throw new AppError(409, 'ORG_UNIT_FROM_ERP', 'หน่วยงานของบุคลากรมาจากระบบ ERP กำหนดเองไม่ได้');
      }
      if (!(await findActiveOrgUnit(client, input.orgUnitId))) {
        throw new AppError(400, 'ORG_UNIT_NOT_FOUND', 'ไม่พบหน่วยงานที่เลือก');
      }
    }

    // มีผู้ใช้อีเมลนี้อยู่แล้ว (ผูก Google แล้ว หรือลงทะเบียนไว้แล้ว) → ไม่สร้างซ้ำ
    if ((await findUsersByEmail(client, input.email)).length > 0) {
      throw new AppError(409, 'EMAIL_EXISTS', 'มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว');
    }

    let userId: string;
    try {
      userId = await insertPreRegisteredUser(client, { ...input, actorId: actor.id });
    } catch (err) {
      // ผู้ดูแล 2 คนลงทะเบียนอีเมลเดียวกันพร้อมกัน — unique index กันไว้
      if (isUniqueViolation(err)) throw new AppError(409, 'EMAIL_EXISTS', 'มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว');
      throw err;
    }

    for (const code of ['user', input.accountType]) {
      const role = await findRoleByCode(client, code);
      if (role) {
        await grantRoleByActor(client, { userId, roleId: role.id, actorId: actor.id, reason: 'ลงทะเบียนล่วงหน้า' });
      }
    }
    await insertUserAuditLog(client, {
      actorId: actor.id,
      targetUserId: userId,
      action: 'create',
      changes: { accountType: input.accountType, preRegistered: true },
      reason,
    });
    return { id: userId };
  });
}
