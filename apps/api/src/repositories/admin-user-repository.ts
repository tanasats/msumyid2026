import type { Queryable } from '../db/types.js';
import type { AccountType, ApprovalStatus } from './session-repository.js';

// SQL ของหน้าจัดการบัญชีผู้ใช้ (ผู้ดูแลระบบ)

export type UserStatusFilter = 'active' | 'pending' | 'rejected' | 'inactive';

export type ListUsersFilter = {
  /** ข้อความค้นหาชื่อแสดงหรือ email (บางส่วน) */
  q: string | null;
  status: UserStatusFilter | null;
  accountType: AccountType | null;
  roleCode: string | null;
  /** id ของแถวสุดท้ายในหน้าก่อน (keyset pagination) */
  afterId: string | null;
  limit: number;
};

export type UserListRow = {
  id: string;
  email: string;
  displayName: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  orgUnitNameTh: string | null;
  roles: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
};

/** escape อักขระพิเศษของ LIKE (\ % _) เพื่อให้ค้นหาตามตัวอักษรจริง */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * รายการผู้ใช้สำหรับหน้าจัดการ — ตัวกรองทุกตัวเป็นแบบ "($n IS NULL OR เงื่อนไข)" ไม่ต้องต่อสตริง SQL
 * - ค้นหา: display_name ILIKE / lower(email) LIKE ใช้ trigram index (users_*_trgm_idx)
 * - status: active = ใช้งานได้, pending/rejected = สถานะอนุมัติ (ที่ยังไม่ถูกปิด), inactive = ถูกปิดบัญชี
 * - role: EXISTS แทน JOIN เพื่อไม่ให้แถวซ้ำเมื่อผู้ใช้มีหลาย role
 * - keyset pagination ด้วย id: id เป็น uuidv7 ซึ่งเรียงตามเวลาสร้าง
 *   "WHERE id < หลังสุดของหน้าก่อน ORDER BY id DESC" เร็วคงที่ทุกหน้า (OFFSET ต้องข้ามแถวทิ้งทุกครั้ง)
 *   ดึงเกิน 1 แถว (limit + 1) เพื่อรู้ว่ามีหน้าถัดไปหรือไม่
 */
export async function listUsers(
  db: Queryable,
  filter: ListUsersFilter,
): Promise<{ rows: UserListRow[]; nextCursor: string | null }> {
  const result = await db.query<UserListRow>(
    `SELECT u.id,
            u.email,
            u.display_name    AS "displayName",
            u.picture_url     AS "pictureUrl",
            u.account_type    AS "accountType",
            u.approval_status AS "approvalStatus",
            u.is_active       AS "isActive",
            ou.name_th        AS "orgUnitNameTh",
            ARRAY(
              SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.code
            ) AS roles,
            u.last_login_at   AS "lastLoginAt",
            u.created_at      AS "createdAt"
     FROM users u
     LEFT JOIN org_units ou ON ou.id = u.org_unit_id
     WHERE u.deleted_at IS NULL
       AND ($1::text IS NULL OR u.display_name ILIKE $1 OR lower(u.email) LIKE lower($1))
       AND ($2::text IS NULL
            OR ($2 = 'active'   AND u.is_active AND u.approval_status = 'approved')
            OR ($2 = 'pending'  AND u.is_active AND u.approval_status = 'pending')
            OR ($2 = 'rejected' AND u.is_active AND u.approval_status = 'rejected')
            OR ($2 = 'inactive' AND NOT u.is_active))
       AND ($3::text IS NULL OR u.account_type = $3)
       AND ($4::text IS NULL OR EXISTS (
             SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id AND r.code = $4))
       AND ($5::uuid IS NULL OR u.id < $5)
     ORDER BY u.id DESC
     LIMIT $6`,
    [
      filter.q ? likePattern(filter.q) : null,
      filter.status,
      filter.accountType,
      filter.roleCode,
      filter.afterId,
      filter.limit + 1,
    ],
  );
  const rows = result.rows.slice(0, filter.limit);
  const nextCursor = result.rows.length > filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}

export type UserDetailRow = {
  id: string;
  email: string;
  displayName: string;
  googleName: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  hasGoogleAccount: boolean;
  orgUnitId: string | null;
  orgUnitNameTh: string | null;
  /** ชื่อที่ผู้ดูแลกำหนดเอง (null = ใช้ชื่อจาก ERP/Google) */
  displayNameOverride: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByName: string | null;
  deactivatedAt: Date | null;
  deactivatedByName: string | null;
  /** วันหมดอายุของบัญชี (บัญชีหน่วยงาน) — null = ไม่หมดอายุ */
  accountExpiresAt: Date | null;
  /** ผู้รับผิดชอบบัญชีหน่วยงาน */
  responsibleUser: { id: string; displayName: string; email: string } | null;
  roles: { code: string; nameTh: string; isSystem: boolean; isPrivileged: boolean; grantedAt: Date }[];
};

/**
 * รายละเอียดผู้ใช้ 1 คน — ชื่อผู้อนุมัติ/ผู้ปิดบัญชีด้วย LEFT JOIN users ซ้ำ (self join) คนละ alias
 * roles: json_agg รวม role เป็น array ของ object ในแถวเดียว (COALESCE กันได้ NULL เมื่อไม่มี role)
 * responsibleUser: CASE คืน NULL เมื่อไม่มีผู้รับผิดชอบ ไม่เช่นนั้นสร้าง object จาก self join อีกตัว
 */
export async function findUserDetail(db: Queryable, userId: string): Promise<UserDetailRow | null> {
  const result = await db.query<UserDetailRow>(
    `SELECT u.id,
            u.email,
            u.display_name          AS "displayName",
            u.name                  AS "googleName",
            u.picture_url           AS "pictureUrl",
            u.account_type          AS "accountType",
            u.approval_status       AS "approvalStatus",
            u.is_active             AS "isActive",
            (u.google_sub IS NOT NULL) AS "hasGoogleAccount",
            u.org_unit_id           AS "orgUnitId",
            ou.name_th              AS "orgUnitNameTh",
            u.display_name_override AS "displayNameOverride",
            u.last_login_at         AS "lastLoginAt",
            u.created_at            AS "createdAt",
            u.approved_at           AS "approvedAt",
            approver.display_name   AS "approvedByName",
            u.deactivated_at        AS "deactivatedAt",
            deactivator.display_name AS "deactivatedByName",
            u.account_expires_at    AS "accountExpiresAt",
            CASE WHEN responsible.id IS NULL THEN NULL
                 ELSE json_build_object('id', responsible.id, 'displayName', responsible.display_name,
                                        'email', responsible.email)
            END                     AS "responsibleUser",
            COALESCE((
              SELECT json_agg(json_build_object(
                       'code', r.code, 'nameTh', r.name_th, 'isSystem', r.is_system,
                       'isPrivileged', r.is_privileged, 'grantedAt', ur.granted_at
                     ) ORDER BY r.is_privileged DESC, r.name_th)
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id
            ), '[]'::json) AS roles
     FROM users u
     LEFT JOIN org_units ou ON ou.id = u.org_unit_id
     LEFT JOIN users approver ON approver.id = u.approved_by
     LEFT JOIN users deactivator ON deactivator.id = u.deactivated_by
     LEFT JOIN users responsible ON responsible.id = u.responsible_user_id
     WHERE u.id = $1
       AND u.deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export type ManagedUserRow = {
  id: string;
  email: string;
  isActive: boolean;
  approvalStatus: ApprovalStatus;
  accountType: AccountType;
  hasPrivilegedRole: boolean;
  orgUnitId: string | null;
  displayNameOverride: string | null;
  accountExpiresAt: Date | null;
  responsibleUserId: string | null;
};

/**
 * ล็อกแถวผู้ใช้เป้าหมายก่อนแก้ (FOR UPDATE) — กันผู้ดูแล 2 คนแก้คนเดียวกันพร้อมกันจนสถานะเพี้ยน
 * ใช้ภายใน withTransaction เท่านั้น (ล็อกปล่อยเมื่อ COMMIT/ROLLBACK)
 * EXISTS ใน SELECT ให้ผลเป็น boolean ไม่ต้องดึงรายการ role มาตรวจในโค้ด
 */
export async function lockManagedUser(db: Queryable, userId: string): Promise<ManagedUserRow | null> {
  const result = await db.query<ManagedUserRow>(
    `SELECT u.id,
            u.email,
            u.is_active       AS "isActive",
            u.approval_status AS "approvalStatus",
            u.account_type    AS "accountType",
            u.org_unit_id     AS "orgUnitId",
            u.display_name_override AS "displayNameOverride",
            u.account_expires_at    AS "accountExpiresAt",
            u.responsible_user_id   AS "responsibleUserId",
            EXISTS (
              SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.is_privileged
            ) AS "hasPrivilegedRole"
     FROM users u
     WHERE u.id = $1
       AND u.deleted_at IS NULL
     FOR UPDATE OF u`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** ปิด/เปิดบัญชี — เปิดคืนล้างข้อมูลผู้ปิด, actorId = null คือระบบปิดเอง (บัญชีหมดอายุ) */
export async function setUserActive(
  db: Queryable,
  input: { userId: string; active: boolean; actorId: string | null },
): Promise<void> {
  await db.query(
    `UPDATE users
     SET is_active      = $2,
         deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END,
         deactivated_by = CASE WHEN $2 THEN NULL ELSE $3::uuid END
     WHERE id = $1`,
    [input.userId, input.active, input.actorId],
  );
}

/** ตั้งสถานะอนุมัติ — approved_by/approved_at เก็บผู้ตัดสิน (ทั้งอนุมัติและปฏิเสธ) ต้องมาคู่กันตาม CHECK */
export async function setApprovalStatus(
  db: Queryable,
  input: { userId: string; status: 'approved' | 'rejected'; actorId: string },
): Promise<void> {
  await db.query(
    `UPDATE users
     SET approval_status = $2,
         approved_by     = $3,
         approved_at     = now()
     WHERE id = $1`,
    [input.userId, input.status, input.actorId],
  );
}

export type UserAuditAction =
  | 'create'
  | 'update'
  | 'deactivate'
  | 'activate'
  | 'delete'
  | 'approve'
  | 'reject'
  | 'link_google'
  | 'expire';

/** บันทึกประวัติการจัดการบัญชี — changes ห้ามมีค่าข้อมูลส่วนบุคคล (ดูคอมเมนต์ใน migration) */
export async function insertUserAuditLog(
  db: Queryable,
  input: {
    actorId: string | null;
    targetUserId: string;
    action: UserAuditAction;
    changes?: Record<string, unknown>;
    reason: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO user_audit_logs (actor_id, target_user_id, action, changes, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.actorId, input.targetUserId, input.action, JSON.stringify(input.changes ?? {}), input.reason],
  );
}

export type UserHistoryRow = {
  id: string;
  /** user = จาก user_audit_logs, role = จาก role_change_logs */
  kind: 'user' | 'role';
  action: string;
  roleNameTh: string | null;
  changes: Record<string, unknown>;
  reason: string | null;
  actorName: string | null;
  createdAt: Date;
};

/**
 * ประวัติของผู้ใช้จาก 2 ตารางรวมเป็นรายการเดียว
 * UNION ALL ต่อผลของ 2 SELECT ที่มีคอลัมน์ตรงกัน (ALL = ไม่ต้องตัดแถวซ้ำ เร็วกว่า UNION)
 * แต่ละฝั่งใช้ index (target_user_id, created_at DESC) แล้วเรียงรวมและตัดด้วย LIMIT
 */
export async function listUserHistory(db: Queryable, userId: string, limit: number): Promise<UserHistoryRow[]> {
  const result = await db.query<UserHistoryRow>(
    `SELECT h.id, h.kind, h.action, h."roleNameTh", h.changes, h.reason,
            actor.display_name AS "actorName", h."createdAt"
     FROM (
       SELECT l.id, 'user' AS kind, l.action, NULL AS "roleNameTh", l.changes, l.reason,
              l.actor_id, l.created_at AS "createdAt"
       FROM user_audit_logs l
       WHERE l.target_user_id = $1
       UNION ALL
       SELECT l.id, 'role' AS kind, l.action, r.name_th AS "roleNameTh", '{}'::jsonb AS changes, l.reason,
              l.actor_id, l.created_at AS "createdAt"
       FROM role_change_logs l
       JOIN roles r ON r.id = l.role_id
       WHERE l.target_user_id = $1
     ) h
     LEFT JOIN users actor ON actor.id = h.actor_id
     ORDER BY h."createdAt" DESC, h.id DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

export type UpdateUserProfileInput = {
  userId: string;
  /** undefined = ไม่แก้, null = ล้าง (กลับไปใช้ชื่อจาก ERP/Google), string = ชื่อใหม่ */
  displayNameOverride?: string | null;
  accountType?: AccountType;
  /** undefined = ไม่แก้, null = ไม่ระบุหน่วยงาน */
  orgUnitId?: string | null;
  /** undefined = ไม่แก้, null = ไม่หมดอายุ */
  accountExpiresAt?: Date | null;
  /** undefined = ไม่แก้, null = ไม่มีผู้รับผิดชอบ */
  responsibleUserId?: string | null;
};

/**
 * แก้ข้อมูลผู้ใช้โดยผู้ดูแล — ช่องที่ไม่ส่งมาคงค่าเดิม
 * - "ส่งมาหรือไม่" ใช้ flag boolean แยก ($2, $5, $7, $9) เพราะ null มีความหมาย (ล้างค่า) ต่างจาก "ไม่แก้"
 *   CASE WHEN flag THEN ค่าใหม่ ELSE ค่าเดิม END
 * - display_name คำนวณใหม่ใน statement เดียวกันตามลำดับเดียวกับตอน login:
 *   override ใหม่ → ชื่อจาก staff_profiles (ERP) → ชื่อจาก Google
 *   (ใน SET อ้างค่าใหม่ของคอลัมน์อื่นไม่ได้ จึงเขียน CASE ของ override ซ้ำ)
 */
export async function updateUserProfile(db: Queryable, input: UpdateUserProfileInput): Promise<void> {
  await db.query(
    `UPDATE users u
     SET display_name_override = CASE WHEN $2 THEN $3::text ELSE u.display_name_override END,
         display_name = COALESCE(
                          CASE WHEN $2 THEN $3::text ELSE u.display_name_override END,
                          (SELECT sp.first_name_th || ' ' || sp.last_name_th
                           FROM staff_profiles sp WHERE sp.user_id = u.id),
                          u.name
                        ),
         account_type = COALESCE($4::text, u.account_type),
         org_unit_id  = CASE WHEN $5 THEN $6::uuid ELSE u.org_unit_id END,
         account_expires_at  = CASE WHEN $7 THEN $8::timestamptz ELSE u.account_expires_at END,
         responsible_user_id = CASE WHEN $9 THEN $10::uuid ELSE u.responsible_user_id END
     WHERE u.id = $1`,
    [
      input.userId,
      input.displayNameOverride !== undefined,
      input.displayNameOverride ?? null,
      input.accountType ?? null,
      input.orgUnitId !== undefined,
      input.orgUnitId ?? null,
      input.accountExpiresAt !== undefined,
      input.accountExpiresAt ?? null,
      input.responsibleUserId !== undefined,
      input.responsibleUserId ?? null,
    ],
  );
}

/** ข้อความแทนชื่อของบัญชีที่ถูกลบข้อมูลส่วนบุคคล */
export const DELETED_USER_NAME = 'ผู้ใช้ที่ถูกลบ';

/**
 * ลบข้อมูลส่วนบุคคลของผู้ใช้ (anonymize) — คงแถวไว้เพราะ log อ้างถึงด้วย id (ลบแถวจริงจะติด foreign key)
 * - google_sub = NULL: คืนตัวระบุ Google ถ้าเจ้าของกลับมา login จะได้บัญชีใหม่ (UNIQUE ยอมให้ NULL ซ้ำได้)
 * - email แทนด้วยค่าที่ไม่ซ้ำและไม่ใช่อีเมลจริง (โดเมน .invalid สงวนไว้ว่าไม่มีอยู่จริง)
 * - ปิดบัญชีด้วย: deactivated_* เก็บค่าเดิมถ้าเคยปิดไว้แล้ว (COALESCE)
 */
export async function anonymizeUser(db: Queryable, input: { userId: string; actorId: string }): Promise<void> {
  await db.query(
    `UPDATE users
     SET deleted_at            = now(),
         is_active             = false,
         deactivated_at        = COALESCE(deactivated_at, now()),
         deactivated_by        = COALESCE(deactivated_by, $2::uuid),
         google_sub            = NULL,
         email                 = 'deleted-' || id || '@deleted.invalid',
         name                  = $3,
         display_name          = $3,
         display_name_override = NULL,
         picture_url           = NULL,
         org_unit_id           = NULL,
         responsible_user_id   = NULL
     WHERE id = $1`,
    [input.userId, input.actorId, DELETED_USER_NAME],
  );
}

/**
 * ลงทะเบียนผู้ใช้ล่วงหน้า — ยังไม่ผูก Google (google_sub = NULL) จะผูกตอนเจ้าของอีเมล login ครั้งแรก
 * - name (ชื่อจาก Google) ใช้ชื่อที่ผู้ดูแลกรอกไปก่อน และจะถูกแทนด้วยชื่อจริงจาก Google ตอน login
 * - อนุมัติไว้แล้ว (approved_by = ผู้ลงทะเบียน) จึงไม่ต้องรออนุมัติแม้เป็นบุคลากรภายนอก
 * - อีเมลซ้ำกับแถวที่ยังไม่ผูก → unique index ปฏิเสธ (error 23505) ให้ service แปลงเป็นข้อความ
 */
export async function insertPreRegisteredUser(
  db: Queryable,
  input: {
    email: string;
    name: string;
    accountType: AccountType;
    orgUnitId: string | null;
    accountExpiresAt: Date | null;
    responsibleUserId: string | null;
    actorId: string;
  },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, display_name, account_type, org_unit_id,
                        account_expires_at, responsible_user_id, approval_status, approved_by, approved_at)
     VALUES (NULL, lower($1), $2, $2, $3, $4, $5, $6, 'approved', $7, now())
     RETURNING id`,
    [
      input.email,
      input.name,
      input.accountType,
      input.orgUnitId,
      input.accountExpiresAt,
      input.responsibleUserId,
      input.actorId,
    ],
  );
  return result.rows[0]!.id;
}

export type ResponsibleCandidateRow = {
  id: string;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
};

/** ข้อมูลที่ใช้ตรวจว่าผู้ใช้คนนี้เป็นผู้รับผิดชอบบัญชีหน่วยงานได้หรือไม่ (ต้องเป็นบุคลากรที่ใช้งานได้) */
export async function findResponsibleCandidate(db: Queryable, userId: string): Promise<ResponsibleCandidateRow | null> {
  const result = await db.query<ResponsibleCandidateRow>(
    `SELECT id,
            account_type    AS "accountType",
            approval_status AS "approvalStatus",
            (is_active AND (account_expires_at IS NULL OR account_expires_at > now())) AS "isActive"
     FROM users
     WHERE id = $1
       AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * ล็อกบัญชีที่ถึงวันหมดอายุแต่ยังเปิดอยู่ทีละชุด (ใช้ partial index users_account_expires_at_idx)
 * FOR UPDATE SKIP LOCKED: ข้ามแถวที่ transaction อื่นล็อกอยู่ (ผู้ดูแลกำลังแก้ หรือ API อีก instance รัน job พร้อมกัน)
 * จึงไม่รอกันและไม่ปิดซ้ำ — แถวที่ถูกข้ามจะถูกปิดในรอบถัดไป
 */
export async function lockExpiredActiveUsers(db: Queryable, limit: number): Promise<{ id: string }[]> {
  const result = await db.query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE account_expires_at IS NOT NULL
       AND account_expires_at <= now()
       AND is_active
       AND deleted_at IS NULL
     ORDER BY account_expires_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows;
}
