import type { Queryable } from '../db/types.js';

// คำขอใบรับรองเสริม (docs/design/certificates.md หัวข้อ "ใบรับรองเสริม")
// วันที่ (date) คืนเป็นข้อความ YYYY-MM-DD ด้วย to_char — pg แปลง date เป็น Date ตามเขตเวลาของเครื่อง ซึ่งเลื่อนวันได้

/** สถานะที่เก็บในตาราง */
export type StoredRequestStatus = 'pending' | 'approved' | 'issued' | 'rejected' | 'cancelled';
/** สถานะที่แสดง: expired = อนุมัติแล้วแต่ไม่มารับใบจนเลยวันสิ้นสุด (คำนวณ ไม่ได้เก็บ) */
export type RequestStatus = StoredRequestStatus | 'expired';

export type SupplementaryRequestRow = {
  id: string;
  purpose: string;
  requestedStart: string;
  requestedEnd: string;
  approvedStart: string | null;
  approvedEnd: string | null;
  status: RequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  certificateId: string | null;
  createdAt: Date;
};

export type AdminSupplementaryRequestRow = SupplementaryRequestRow & {
  /** null = ผู้ขอถูกลบบัญชีแล้ว */
  requester: { id: string; displayName: string; email: string; accountType: string } | null;
};

/** วันนี้ตามเวลาประเทศไทย — ใช้ที่เดียวกันทุก query ให้ตรงกับที่ service คำนวณ */
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Bangkok')::date`;

const STATUS_SQL = `CASE WHEN r.status = 'approved' AND r.approved_end < ${TODAY_SQL} THEN 'expired' ELSE r.status END`;

// ผู้ตัดสินที่ถูกลบบัญชีแล้วไม่แสดงชื่อ (PDPA) — LEFT JOIN d
const COLUMNS = `r.id,
            r.purpose,
            to_char(r.requested_start, 'YYYY-MM-DD') AS "requestedStart",
            to_char(r.requested_end, 'YYYY-MM-DD')   AS "requestedEnd",
            to_char(r.approved_start, 'YYYY-MM-DD')  AS "approvedStart",
            to_char(r.approved_end, 'YYYY-MM-DD')    AS "approvedEnd",
            ${STATUS_SQL}                            AS status,
            d.id                                     AS "deciderId",
            d.display_name                           AS "deciderName",
            r.decided_at                             AS "decidedAt",
            r.decision_note                          AS "decisionNote",
            r.certificate_id                         AS "certificateId",
            r.created_at                             AS "createdAt"`;

type RawRow = Omit<SupplementaryRequestRow, 'decidedBy'> & { deciderId: string | null; deciderName: string | null };

function toRow({ deciderId, deciderName, ...row }: RawRow): SupplementaryRequestRow {
  return { ...row, decidedBy: deciderId ? { id: deciderId, displayName: deciderName ?? '' } : null };
}

/** คำขอของผู้ใช้ ล่าสุดก่อน (ใช้ index supplementary_requests_user_id_idx) */
export async function listRequestsByUser(db: Queryable, userId: string, limit: number): Promise<SupplementaryRequestRow[]> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     FROM supplementary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map(toRow);
}

/**
 * จำนวน "ช่อง" ใบเสริมที่ผู้ใช้ใช้อยู่ = ใบเสริมที่ใช้งานอยู่ + คำขอที่รออนุมัติ + คำขอที่อนุมัติแล้วยังไม่รับ (ยังไม่หมดเวลา)
 * นับคำขอที่ค้างด้วย กันส่งคำขอทีละมาก ๆ แล้วได้ใบเกินเพดานเมื่ออนุมัติพร้อมกัน
 * ต้องเรียกหลัง lockUserForCertificate ใน transaction เดียวกัน จึงนับได้ถูกต้องเมื่อทำพร้อมกัน
 */
export async function countOpenSupplementary(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM certificates
             WHERE user_id = $1 AND kind = 'supplementary' AND revoked_at IS NULL AND not_after > now())
          + (SELECT count(*) FROM supplementary_certificate_requests
             WHERE user_id = $1
               AND (status = 'pending' OR (status = 'approved' AND approved_end >= ${TODAY_SQL}))) AS n`,
    [userId],
  );
  return Number(result.rows[0]!.n);
}

export async function insertRequest(
  db: Queryable,
  input: { userId: string; purpose: string; startDate: string; endDate: string },
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO supplementary_certificate_requests (user_id, purpose, requested_start, requested_end)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.userId, input.purpose, input.startDate, input.endDate],
  );
  return result.rows[0]!;
}

export async function findRequestById(db: Queryable, id: string): Promise<SupplementaryRequestRow | null> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     FROM supplementary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     WHERE r.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toRow(row) : null;
}

export type RequestForUpdate = {
  id: string;
  userId: string;
  /** สถานะที่เก็บจริง (ไม่แปลงเป็น expired) */
  status: StoredRequestStatus;
  approvedStart: string | null;
  approvedEnd: string | null;
  /** วันสิ้นสุดที่อนุมัติผ่านไปแล้ว (เทียบวันนี้ตามเวลาไทย) */
  isExpired: boolean;
};

/**
 * อ่านคำขอพร้อมล็อกแถว (FOR UPDATE) ก่อนเปลี่ยนสถานะ — กันอนุมัติ/ยกเลิก/รับใบซ้อนกัน
 * ไม่กรองเจ้าของใน SQL: service ตอบ "ไม่พบ" เหมือนกันทั้งคำขอที่ไม่มีและคำขอของคนอื่น
 */
export async function findRequestForUpdate(db: Queryable, id: string): Promise<RequestForUpdate | null> {
  const result = await db.query<RequestForUpdate>(
    `SELECT id,
            user_id                                AS "userId",
            status,
            to_char(approved_start, 'YYYY-MM-DD')  AS "approvedStart",
            to_char(approved_end, 'YYYY-MM-DD')    AS "approvedEnd",
            COALESCE(approved_end < ${TODAY_SQL}, false) AS "isExpired"
     FROM supplementary_certificate_requests
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** เจ้าของคำขอ (ไม่ล็อก) — ใช้ล็อกผู้ใช้ก่อนล็อกคำขอ (ลำดับ ผู้ใช้ → คำขอ เหมือนตอนรับใบ) */
export async function findRequestOwnerId(db: Queryable, id: string): Promise<string | null> {
  const result = await db.query<{ userId: string }>(
    `SELECT user_id AS "userId" FROM supplementary_certificate_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0]?.userId ?? null;
}

/** อนุมัติ — เงื่อนไข status = 'pending' กันเขียนทับคำขอที่ถูกตัดสินไปแล้ว คืน false ถ้าไม่ได้แก้ */
export async function approveRequest(
  db: Queryable,
  input: { id: string; startDate: string; endDate: string; actorId: string; note: string | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE supplementary_certificate_requests
     SET status = 'approved', approved_start = $2, approved_end = $3,
         decided_by = $4, decided_at = now(), decision_note = $5
     WHERE id = $1
       AND status = 'pending'`,
    [input.id, input.startDate, input.endDate, input.actorId, input.note],
  );
  return result.rowCount === 1;
}

export async function rejectRequest(db: Queryable, input: { id: string; actorId: string; note: string }): Promise<boolean> {
  const result = await db.query(
    `UPDATE supplementary_certificate_requests
     SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
     WHERE id = $1
       AND status = 'pending'`,
    [input.id, input.actorId, input.note],
  );
  return result.rowCount === 1;
}

/** ยกเลิกคำขอที่ยังไม่ออกใบ (รออนุมัติ หรืออนุมัติแล้วยังไม่รับ) */
export async function cancelRequest(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE supplementary_certificate_requests
     SET status = 'cancelled'
     WHERE id = $1
       AND status IN ('pending', 'approved')`,
    [id],
  );
  return result.rowCount === 1;
}

export async function markRequestIssued(db: Queryable, input: { id: string; certificateId: string }): Promise<void> {
  await db.query(
    `UPDATE supplementary_certificate_requests
     SET status = 'issued', certificate_id = $2
     WHERE id = $1
       AND status = 'approved'`,
    [input.id, input.certificateId],
  );
}

/** ยกเลิกคำขอที่ค้างทั้งหมดของผู้ใช้ (ปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ) — คืน id ที่ยกเลิก */
export async function cancelOpenRequestsByUser(db: Queryable, userId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE supplementary_certificate_requests
     SET status = 'cancelled'
     WHERE user_id = $1
       AND status IN ('pending', 'approved')
     RETURNING id`,
    [userId],
  );
  return result.rows.map((r) => r.id);
}

/** ลบข้อมูลส่วนบุคคลในคำขอของผู้ใช้ที่ถูกลบบัญชี (PDPA) — คงแถว ช่วงวันที่ และสถานะไว้ให้ log อ้างถึง */
export async function erasePersonalDataFromRequests(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE supplementary_certificate_requests
     SET purpose = '', decision_note = NULL
     WHERE user_id = $1`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export type RequestLogAction = 'submit' | 'approve' | 'reject' | 'cancel' | 'issue';

export async function insertRequestLog(
  db: Queryable,
  input: {
    requestId: string;
    actorId: string | null;
    action: RequestLogAction;
    rangeStart?: string | null;
    rangeEnd?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO supplementary_certificate_request_logs (request_id, actor_id, action, range_start, range_end)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.requestId, input.actorId, input.action, input.rangeStart ?? null, input.rangeEnd ?? null],
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

function toAdminRow({ requesterId, requesterName, requesterEmail, requesterAccountType, ...row }: AdminRawRow): AdminSupplementaryRequestRow {
  return {
    ...toRow(row),
    requester: requesterId
      ? {
          id: requesterId,
          displayName: requesterName ?? '',
          email: requesterEmail ?? '',
          accountType: requesterAccountType ?? '',
        }
      : null,
  };
}

/**
 * คิวคำขอที่รออนุมัติ เก่าก่อน (ใช้ partial index supplementary_requests_pending_idx)
 * ไม่แบ่งหน้า: คิวมักสั้น — จำกัดจำนวนไว้และแสดงจำนวนทั้งหมดแยก (countPendingRequests)
 */
export async function listPendingRequests(db: Queryable, limit: number): Promise<AdminSupplementaryRequestRow[]> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     FROM supplementary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.status = 'pending'
     ORDER BY r.created_at, r.id
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(toAdminRow);
}

export async function countPendingRequests(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM supplementary_certificate_requests WHERE status = 'pending'`,
  );
  return result.rows[0]!.n;
}

/**
 * ประวัติคำขอที่ตัดสินแล้ว ล่าสุดก่อน — keyset pagination ด้วย id (uuidv7 เรียงตามเวลาสร้าง)
 * สถานะ expired แปลงเป็นเงื่อนไขเดียวกับ STATUS_SQL, ดึงเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไป
 */
export async function searchDecidedRequests(
  db: Queryable,
  filter: { status: Exclude<RequestStatus, 'pending'> | null; afterId: string | null; limit: number },
): Promise<{ rows: AdminSupplementaryRequestRow[]; nextCursor: string | null }> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     FROM supplementary_certificate_requests r
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL
     LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL
     WHERE r.status <> 'pending'
       AND ($1::text IS NULL OR ${STATUS_SQL} = $1)
       AND ($2::uuid IS NULL OR r.id < $2)
     ORDER BY r.id DESC
     LIMIT $3`,
    [filter.status, filter.afterId, filter.limit + 1],
  );
  const rows = result.rows.slice(0, filter.limit).map(toAdminRow);
  const nextCursor = result.rows.length > filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}
