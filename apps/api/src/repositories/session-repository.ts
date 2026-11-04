import type { Queryable } from '../db/types.js';

/**
 * service = บัญชีหน่วยงาน (ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม ไม่ใช่ของบุคคล)
 * unclassified = รอจำแนกประเภท (บัญชี มมส. ที่ ERP ไม่พบ — บุคลากรภายนอกหรือบัญชีหน่วยงาน ผู้อนุมัติเป็นผู้เลือก)
 */
export type AccountType = 'student' | 'staff' | 'external' | 'service' | 'unclassified';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type SessionUserRow = {
  sessionId: string;
  userId: string;
  email: string;
  /** ชื่อแสดงของระบบ (users.display_name) ไม่ใช่ชื่อจาก Google */
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  /** รับทราบประกาศความเป็นส่วนตัวเวอร์ชันที่ส่งมาแล้วหรือยัง */
  privacyAcknowledged: boolean;
  roles: string[];
  permissions: string[];
  /** เปิด MFA แล้ว (ยืนยันรหัสแรกแล้ว) */
  mfaEnabled: boolean;
  /** ถือ role ที่บังคับ MFA อย่างน้อย 1 role */
  mfaRequired: boolean;
  /** session นี้ยืนยัน MFA ล่าสุดเมื่อไร (NULL = ยังไม่ยืนยัน) */
  mfaVerifiedAt: Date | null;
};

export async function insertSession(
  db: Queryable,
  input: { tokenHash: Buffer; userId: string; expiresAt: Date },
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.tokenHash, input.userId, input.expiresAt],
  );
  return result.rows[0]!;
}

/**
 * หา session ที่ยังไม่หมดอายุ พร้อมข้อมูลผู้ใช้ role และ permission ใน query เดียว
 * - roles: ARRAY(subquery) ได้ role ทั้งหมดของผู้ใช้เป็น text[]
 * - permissions: union ของ permission จากทุก role (DISTINCT กันซ้ำเมื่อหลาย role มี permission เดียวกัน)
 * - ไม่กรอง is_active ที่นี่ เพื่อให้ service ตัดสินและลบ session ของผู้ใช้ที่ถูกระงับได้
 * - บัญชีที่ถึงวันหมดอายุแล้วถือว่าถูกระงับทันที (isActive = false) ไม่ต้องรอ job ปิดบัญชี
 * - privacyAcknowledged: EXISTS บน UNIQUE (user_id, notice_version) — อ่าน index แถวเดียว ไม่เพิ่มภาระต่อ request
 * - mfaEnabled: EXISTS บน UNIQUE (user_id) ของ user_mfa_totp, mfaRequired: มี role ที่ถืออยู่และบังคับ MFA หรือไม่
 */
export async function findSessionUser(
  db: Queryable,
  tokenHash: Buffer,
  privacyNoticeVersion: number,
): Promise<SessionUserRow | null> {
  const result = await db.query<SessionUserRow>(
    `SELECT s.id               AS "sessionId",
            u.id               AS "userId",
            u.email,
            u.display_name     AS name,
            u.picture_url      AS "pictureUrl",
            u.account_type     AS "accountType",
            u.approval_status  AS "approvalStatus",
            (u.is_active AND (u.account_expires_at IS NULL OR u.account_expires_at > now())) AS "isActive",
            EXISTS (
              SELECT 1 FROM privacy_acknowledgements pa
              WHERE pa.user_id = u.id AND pa.notice_version = $2
            ) AS "privacyAcknowledged",
            ARRAY(
              SELECT r.code
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id
              ORDER BY r.code
            ) AS roles,
            ARRAY(
              SELECT DISTINCT p.code
              FROM user_roles ur
              JOIN role_permissions rp ON rp.role_id = ur.role_id
              JOIN permissions p ON p.id = rp.permission_id
              WHERE ur.user_id = u.id
              ORDER BY p.code
            ) AS permissions,
            EXISTS (
              SELECT 1 FROM user_mfa_totp t
              WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL
            ) AS "mfaEnabled",
            EXISTS (
              SELECT 1
              FROM user_roles ur
              JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id AND r.mfa_required
            ) AS "mfaRequired",
            s.mfa_verified_at  AS "mfaVerifiedAt"
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.deleted_at IS NULL`,
    [tokenHash, privacyNoticeVersion],
  );
  return result.rows[0] ?? null;
}

/**
 * ลบ session ที่หมดอายุทีละชุด (กันล็อกตารางนาน) — subquery เลือก id ที่หมดอายุไม่เกิน limit แถว ผ่าน index sessions_expires_at_idx
 * คืนจำนวนที่ลบ: น้อยกว่า limit = หมดแล้ว
 */
export async function deleteExpiredSessions(db: Queryable, limit: number): Promise<number> {
  const result = await db.query(
    `DELETE FROM sessions
     WHERE id IN (SELECT id FROM sessions WHERE expires_at <= now() LIMIT $1)`,
    [limit],
  );
  return result.rowCount ?? 0;
}

/**
 * อัปเดต last_seen_at ไม่เกิน 1 ครั้งต่อ 5 นาที
 * เงื่อนไขอยู่ใน WHERE จึงไม่เกิดการเขียนเลยถ้าเพิ่งอัปเดตไป (ลดภาระฐานข้อมูลทุก request)
 */
export async function touchSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query(
    `UPDATE sessions
     SET last_seen_at = now()
     WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`,
    [sessionId],
  );
}

export async function deleteSessionByHash(db: Queryable, tokenHash: Buffer): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

/** เพิกถอนทุก session ของผู้ใช้ (เช่น ถูกระงับ) */
export async function deleteSessionsByUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return result.rowCount ?? 0;
}

/** เวลาที่สร้าง session (= เวลาที่ login) — ใช้กับงานที่ต้อง login ใหม่เร็ว ๆ นี้ เช่น รีเซ็ต PIN ลงนาม */
export async function findSessionCreatedAt(db: Queryable, sessionId: string): Promise<Date | null> {
  const result = await db.query<{ createdAt: Date }>(`SELECT created_at AS "createdAt" FROM sessions WHERE id = $1`, [
    sessionId,
  ]);
  return result.rows[0]?.createdAt ?? null;
}

/** session นี้ยืนยัน MFA แล้ว (ตอนเปิด MFA หรือยืนยันซ้ำก่อนทำรายการสำคัญ) */
export async function markSessionMfaVerified(db: Queryable, sessionId: string): Promise<void> {
  await db.query(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [sessionId]);
}

/**
 * ยืนยัน MFA ตอนเข้าสู่ระบบ: เปลี่ยน token ของ session พร้อมตั้งเวลาที่ยืนยัน (กัน session fixation —
 * token ที่ใช้ก่อนยืนยันใช้ต่อไม่ได้) คืนวันหมดอายุเดิมของ session ไว้ตั้ง cookie ใหม่
 */
export async function rotateSessionTokenAfterMfa(
  db: Queryable,
  input: { sessionId: string; tokenHash: Buffer },
): Promise<{ expiresAt: Date } | null> {
  const result = await db.query<{ expiresAt: Date }>(
    `UPDATE sessions
     SET token_hash = $2, mfa_verified_at = now()
     WHERE id = $1 AND expires_at > now()
     RETURNING expires_at AS "expiresAt"`,
    [input.sessionId, input.tokenHash],
  );
  return result.rows[0] ?? null;
}
