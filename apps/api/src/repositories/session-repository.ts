import type { Queryable } from '../db/types.js';

export type AccountType = 'student' | 'staff' | 'external';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export type SessionUserRow = {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  roles: string[];
  permissions: string[];
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
 */
export async function findSessionUser(db: Queryable, tokenHash: Buffer): Promise<SessionUserRow | null> {
  const result = await db.query<SessionUserRow>(
    `SELECT s.id               AS "sessionId",
            u.id               AS "userId",
            u.email,
            u.name,
            u.picture_url      AS "pictureUrl",
            u.account_type     AS "accountType",
            u.approval_status  AS "approvalStatus",
            u.is_active        AS "isActive",
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
            ) AS permissions
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.deleted_at IS NULL`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
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
