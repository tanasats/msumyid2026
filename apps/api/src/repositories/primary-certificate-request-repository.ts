import type { Queryable } from '../db/types.js';

// คำขอใบรับรองประจำตัวแบบรออนุมัติ (docs/design/certificates.md หัวข้อ "ใบประจำตัวแบบส่งคำขอ")

/** สถานะที่เก็บในตาราง */
export type StoredPrimaryRequestStatus = 'pending' | 'approved' | 'issued' | 'rejected' | 'cancelled';
/** สถานะที่แสดง: expired = อนุมัติแล้วแต่ไม่รับใบภายในเวลาที่กำหนด (คำนวณ ไม่ได้เก็บ) */
export type PrimaryRequestStatus = StoredPrimaryRequestStatus | 'expired';

export type PrimaryRequestRow = {
  id: string;
  purpose: string | null;
  status: PrimaryRequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: Date | null;
  /** วันสุดท้ายที่รับใบได้ (มีค่าเมื่ออนุมัติแล้ว) */
  claimableUntil: Date | null;
  decisionNote: string | null;
  certificateId: string | null;
  createdAt: Date;
};

export type AdminPrimaryRequestRow = PrimaryRequestRow & {
  /** null = ผู้ขอถูกลบบัญชีแล้ว */
  requester: { id: string; displayName: string; email: string; accountType: string } | null;
};

// $1 ของทุก query ที่ใช้ STATUS_SQL = จำนวนวันที่รับใบได้หลังอนุมัติ (service เป็นผู้กำหนด)
const STATUS_SQL = `CASE WHEN r.status = 'approved' AND r.decided_at + make_interval(days => $1::int) <= now()
                         THEN 'expired' ELSE r.status END`;

const COLUMNS = `r.id,
            r.purpose,
            ${STATUS_SQL}                       AS status,
            d.id                                AS "deciderId",
            d.display_name                      AS "deciderName",
            r.decided_at                        AS "decidedAt",
            CASE WHEN r.status = 'approved' THEN r.decided_at + make_interval(days => $1::int) END AS "claimableUntil",
            r.decision_note                     AS "decisionNote",
            r.certificate_id                    AS "certificateId",
            r.created_at                        AS "createdAt"`;

type RawRow = Omit<PrimaryRequestRow, 'decidedBy'> & { deciderId: string | null; deciderName: string | null };

function toRow({ deciderId, deciderName, ...row }: RawRow): PrimaryRequestRow {
  return { ...row, decidedBy: deciderId ? { id: deciderId, displayName: deciderName ?? '' } : null };
}

/** คำขอของผู้ใช้ ล่าสุดก่อน (ใช้ index primary_requests_user_id_idx) — ผู้ตัดสินที่ถูกลบบัญชีไม่แสดงชื่อ */
export async function listPrimaryRequestsByUser(
  db: Queryable,
  input: { userId: string; claimDays: number; limit: number },
): Promise<PrimaryRequestRow[]> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     FROM primary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     WHERE r.user_id = $2
     ORDER BY r.created_at DESC
     LIMIT $3`,
    [input.claimDays, input.userId, input.limit],
  );
  return result.rows.map(toRow);
}

export async function findPrimaryRequestById(db: Queryable, id: string, claimDays: number): Promise<PrimaryRequestRow | null> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     FROM primary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     WHERE r.id = $2`,
    [claimDays, id],
  );
  const row = result.rows[0];
  return row ? toRow(row) : null;
}

/**
 * มีคำขอที่ยังค้างอยู่หรือไม่ (รออนุมัติ หรืออนุมัติแล้วยังไม่หมดเวลารับใบ) — กฎ "คำขอค้างได้ 1 รายการ"
 * ต้องเรียกหลัง lockUserForCertificate ใน transaction เดียวกัน จึงตรวจได้ถูกต้องเมื่อส่งพร้อมกัน
 */
export async function hasOpenPrimaryRequest(db: Queryable, userId: string, claimDays: number): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM primary_certificate_requests
     WHERE user_id = $1
       AND (status = 'pending'
            OR (status = 'approved' AND decided_at + make_interval(days => $2::int) > now()))
     LIMIT 1`,
    [userId, claimDays],
  );
  return result.rowCount === 1;
}

export async function insertPrimaryRequest(db: Queryable, input: { userId: string; purpose: string | null }): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO primary_certificate_requests (user_id, purpose) VALUES ($1, $2) RETURNING id`,
    [input.userId, input.purpose],
  );
  return result.rows[0]!;
}

export type PrimaryRequestForUpdate = {
  id: string;
  userId: string;
  /** สถานะที่เก็บจริง (ไม่แปลงเป็น expired) */
  status: StoredPrimaryRequestStatus;
  /** อนุมัติแล้วแต่เลยเวลารับใบ */
  isExpired: boolean;
};

/** อ่านคำขอพร้อมล็อกแถว (FOR UPDATE) — service ตอบ "ไม่พบ" เหมือนกันทั้งคำขอที่ไม่มีและคำขอของคนอื่น */
export async function findPrimaryRequestForUpdate(
  db: Queryable,
  id: string,
  claimDays: number,
): Promise<PrimaryRequestForUpdate | null> {
  const result = await db.query<PrimaryRequestForUpdate>(
    `SELECT id,
            user_id AS "userId",
            status,
            (status = 'approved' AND decided_at + make_interval(days => $2::int) <= now()) AS "isExpired"
     FROM primary_certificate_requests
     WHERE id = $1
     FOR UPDATE`,
    [id, claimDays],
  );
  return result.rows[0] ?? null;
}

/** เจ้าของคำขอ (ไม่ล็อก) — ใช้ล็อกผู้ใช้ก่อนล็อกคำขอ (ลำดับ ผู้ใช้ → คำขอ เหมือนตอนรับใบ) */
export async function findPrimaryRequestOwnerId(db: Queryable, id: string): Promise<string | null> {
  const result = await db.query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM primary_certificate_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0]?.userId ?? null;
}

/** อนุมัติ/ปฏิเสธ — เงื่อนไข status = 'pending' กันเขียนทับคำขอที่ถูกตัดสินแล้ว */
export async function decidePrimaryRequest(
  db: Queryable,
  input: { id: string; status: 'approved' | 'rejected'; actorId: string; note: string | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE primary_certificate_requests
     SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
     WHERE id = $1
       AND status = 'pending'`,
    [input.id, input.status, input.actorId, input.note],
  );
  return result.rowCount === 1;
}

export async function cancelPrimaryRequest(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE primary_certificate_requests SET status = 'cancelled' WHERE id = $1 AND status IN ('pending', 'approved')`,
    [id],
  );
  return result.rowCount === 1;
}

export async function markPrimaryRequestIssued(db: Queryable, input: { id: string; certificateId: string }): Promise<void> {
  await db.query(
    `UPDATE primary_certificate_requests SET status = 'issued', certificate_id = $2 WHERE id = $1 AND status = 'approved'`,
    [input.id, input.certificateId],
  );
}

/** ยกเลิกคำขอที่ค้างทั้งหมดของผู้ใช้ (ปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ) — คืน id ที่ยกเลิก */
export async function cancelOpenPrimaryRequestsByUser(db: Queryable, userId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE primary_certificate_requests
     SET status = 'cancelled'
     WHERE user_id = $1 AND status IN ('pending', 'approved')
     RETURNING id`,
    [userId],
  );
  return result.rows.map((r) => r.id);
}

/** ลบข้อมูลส่วนบุคคลในคำขอของผู้ใช้ที่ถูกลบบัญชี (PDPA) — คงแถวและสถานะไว้ให้ log อ้างถึง */
export async function erasePersonalDataFromPrimaryRequests(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE primary_certificate_requests SET purpose = NULL, decision_note = NULL WHERE user_id = $1`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export type PrimaryRequestLogAction = 'submit' | 'approve' | 'reject' | 'cancel' | 'issue';

export async function insertPrimaryRequestLog(
  db: Queryable,
  input: { requestId: string; actorId: string | null; action: PrimaryRequestLogAction },
): Promise<void> {
  await db.query(
    `INSERT INTO primary_certificate_request_logs (request_id, actor_id, action) VALUES ($1, $2, $3)`,
    [input.requestId, input.actorId, input.action],
  );
}

// ---- ผู้อนุมัติ ----

const ADMIN_COLUMNS = `${COLUMNS},
            u.id           AS "requesterId",
            u.display_name AS "requesterName",
            u.email        AS "requesterEmail",
            u.account_type AS "requesterAccountType"`;

type AdminRawRow = RawRow & {
  requesterId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterAccountType: string | null;
};

function toAdminRow({ requesterId, requesterName, requesterEmail, requesterAccountType, ...row }: AdminRawRow): AdminPrimaryRequestRow {
  return {
    ...toRow(row),
    requester: requesterId
      ? { id: requesterId, displayName: requesterName ?? '', email: requesterEmail ?? '', accountType: requesterAccountType ?? '' }
      : null,
  };
}

/** คิวรออนุมัติ เก่าก่อน (partial index primary_requests_pending_idx) ไม่แบ่งหน้า — จำนวนทั้งหมดดูจาก countPendingPrimaryRequests */
export async function listPendingPrimaryRequests(db: Queryable, input: { claimDays: number; limit: number }): Promise<AdminPrimaryRequestRow[]> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     FROM primary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.status = 'pending'
     ORDER BY r.created_at, r.id
     LIMIT $2`,
    [input.claimDays, input.limit],
  );
  return result.rows.map(toAdminRow);
}

export async function countPendingPrimaryRequests(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM primary_certificate_requests WHERE status = 'pending'`,
  );
  return result.rows[0]!.n;
}

/** ประวัติที่ตัดสินแล้ว ล่าสุดก่อน — keyset pagination ด้วย id, ดึงเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไป */
export async function searchDecidedPrimaryRequests(
  db: Queryable,
  filter: { status: Exclude<PrimaryRequestStatus, 'pending'> | null; afterId: string | null; limit: number; claimDays: number },
): Promise<{ rows: AdminPrimaryRequestRow[]; nextCursor: string | null }> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     FROM primary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.status <> 'pending'
       AND ($2::text IS NULL OR ${STATUS_SQL} = $2)
       AND ($3::uuid IS NULL OR r.id < $3)
     ORDER BY r.id DESC
     LIMIT $4`,
    [filter.claimDays, filter.status, filter.afterId, filter.limit + 1],
  );
  const rows = result.rows.slice(0, filter.limit).map(toAdminRow);
  const nextCursor = result.rows.length > filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}
