import type { Queryable } from '../db/types.js';

// คำขอเพิกถอนใบรับรองประจำตัว (docs/design/certificates.md หัวข้อ "การควบคุมการเพิกถอน")

/** เหตุผลที่ต้องส่งคำขอ (keyCompromise เพิกถอนเองได้ทันที ไม่ผ่านคำขอ) */
export type RevocationRequestReason = 'superseded' | 'affiliationChanged' | 'cessationOfOperation';
export type RevocationRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type RevocationRequestRow = {
  id: string;
  certificate: { id: string; serialNumber: string; notAfter: Date };
  reason: RevocationRequestReason;
  status: RevocationRequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
};

export type AdminRevocationRequestRow = RevocationRequestRow & {
  /** null = ผู้ขอถูกลบบัญชีแล้ว */
  requester: { id: string; displayName: string; email: string; accountType: string } | null;
};

const COLUMNS = `r.id,
            c.id                 AS "certificateId",
            c.serial_number      AS "serialNumber",
            c.not_after          AS "notAfter",
            r.reason,
            r.status,
            d.id                 AS "deciderId",
            d.display_name       AS "deciderName",
            r.decided_at         AS "decidedAt",
            r.decision_note      AS "decisionNote",
            r.created_at         AS "createdAt"`;

// ใบรับรองไม่มีวันถูกลบ (ต้องอยู่ใน CRL) จึง JOIN ได้เสมอ — ผู้ตัดสินที่ถูกลบบัญชีไม่แสดงชื่อ
const FROM = `FROM certificate_revocation_requests r
     JOIN certificates c ON c.id = r.certificate_id
     LEFT JOIN users d ON d.id = r.decided_by AND d.deleted_at IS NULL`;

type RawRow = Omit<RevocationRequestRow, 'certificate' | 'decidedBy'> & {
  certificateId: string;
  serialNumber: string;
  notAfter: Date;
  deciderId: string | null;
  deciderName: string | null;
};

function toRow({ certificateId, serialNumber, notAfter, deciderId, deciderName, ...row }: RawRow): RevocationRequestRow {
  return {
    ...row,
    certificate: { id: certificateId, serialNumber, notAfter },
    decidedBy: deciderId ? { id: deciderId, displayName: deciderName ?? '' } : null,
  };
}

/** คำขอของผู้ใช้ ล่าสุดก่อน (ใช้ index revocation_requests_user_id_idx) */
export async function listRevocationRequestsByUser(
  db: Queryable,
  input: { userId: string; limit: number },
): Promise<RevocationRequestRow[]> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     ${FROM}
     WHERE r.user_id = $1
     ORDER BY r.created_at DESC
     LIMIT $2`,
    [input.userId, input.limit],
  );
  return result.rows.map(toRow);
}

export async function findRevocationRequestById(db: Queryable, id: string): Promise<RevocationRequestRow | null> {
  const result = await db.query<RawRow>(
    `SELECT ${COLUMNS}
     ${FROM}
     WHERE r.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toRow(row) : null;
}

/** ใบนี้มีคำขอที่รออนุมัติอยู่หรือไม่ — เรียกหลังล็อกแถวใบรับรองแล้ว (unique index กันซ้ำอีกชั้น) */
export async function hasPendingRevocationRequest(db: Queryable, certificateId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM certificate_revocation_requests WHERE certificate_id = $1 AND status = 'pending' LIMIT 1`,
    [certificateId],
  );
  return result.rowCount === 1;
}

export async function insertRevocationRequest(
  db: Queryable,
  input: { certificateId: string; userId: string; reason: RevocationRequestReason },
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO certificate_revocation_requests (certificate_id, user_id, reason) VALUES ($1, $2, $3) RETURNING id`,
    [input.certificateId, input.userId, input.reason],
  );
  return result.rows[0]!;
}

/** เจ้าของคำขอและใบ (ไม่ล็อก) — ผู้เรียกใช้ล็อกตามลำดับ ผู้ใช้ → ใบ → คำขอ (เหมือนการเพิกถอนทางอื่น กัน deadlock) */
export async function findRevocationRequestRefs(
  db: Queryable,
  id: string,
): Promise<{ userId: string; certificateId: string } | null> {
  const result = await db.query<{ userId: string; certificateId: string }>(
    `SELECT user_id AS "userId", certificate_id AS "certificateId" FROM certificate_revocation_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export type RevocationRequestForUpdate = {
  id: string;
  userId: string;
  certificateId: string;
  reason: RevocationRequestReason;
  status: RevocationRequestStatus;
};

/** อ่านคำขอพร้อมล็อกแถว (FOR UPDATE) */
export async function findRevocationRequestForUpdate(db: Queryable, id: string): Promise<RevocationRequestForUpdate | null> {
  const result = await db.query<RevocationRequestForUpdate>(
    `SELECT id, user_id AS "userId", certificate_id AS "certificateId", reason, status
     FROM certificate_revocation_requests
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** อนุมัติ/ปฏิเสธ — เงื่อนไข status = 'pending' กันเขียนทับคำขอที่ถูกตัดสินแล้ว */
export async function decideRevocationRequest(
  db: Queryable,
  input: { id: string; status: 'approved' | 'rejected'; actorId: string; note: string | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE certificate_revocation_requests
     SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4
     WHERE id = $1
       AND status = 'pending'`,
    [input.id, input.status, input.actorId, input.note],
  );
  return result.rowCount === 1;
}

export async function cancelRevocationRequest(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE certificate_revocation_requests SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  return result.rowCount === 1;
}

/** ยกเลิกคำขอที่รออนุมัติของใบเหล่านี้ (ใบถูกเพิกถอนด้วยทางอื่นแล้ว) — คืน id ที่ยกเลิก */
export async function cancelPendingRevocationRequestsForCertificates(
  db: Queryable,
  certificateIds: string[],
): Promise<string[]> {
  if (certificateIds.length === 0) return [];
  const result = await db.query<{ id: string }>(
    `UPDATE certificate_revocation_requests
     SET status = 'cancelled'
     WHERE certificate_id = ANY($1::uuid[]) AND status = 'pending'
     RETURNING id`,
    [certificateIds],
  );
  return result.rows.map((r) => r.id);
}

/** ยกเลิกคำขอที่รออนุมัติทั้งหมดของผู้ใช้ (ปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ) — คืน id ที่ยกเลิก */
export async function cancelPendingRevocationRequestsByUser(db: Queryable, userId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE certificate_revocation_requests
     SET status = 'cancelled'
     WHERE user_id = $1 AND status = 'pending'
     RETURNING id`,
    [userId],
  );
  return result.rows.map((r) => r.id);
}

/** ลบข้อมูลส่วนบุคคลในคำขอของผู้ใช้ที่ถูกลบบัญชี (PDPA) — คงแถวและสถานะไว้ให้ log อ้างถึง */
export async function erasePersonalDataFromRevocationRequests(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE certificate_revocation_requests SET decision_note = NULL WHERE user_id = $1 AND decision_note IS NOT NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export type RevocationRequestLogAction = 'submit' | 'approve' | 'reject' | 'cancel';

export async function insertRevocationRequestLog(
  db: Queryable,
  input: { requestId: string; actorId: string | null; action: RevocationRequestLogAction },
): Promise<void> {
  await db.query(
    `INSERT INTO certificate_revocation_request_logs (request_id, actor_id, action) VALUES ($1, $2, $3)`,
    [input.requestId, input.actorId, input.action],
  );
}

// ---- ผู้อนุมัติ ----

const ADMIN_COLUMNS = `${COLUMNS},
            u.id           AS "requesterId",
            u.display_name AS "requesterName",
            u.email        AS "requesterEmail",
            u.account_type AS "requesterAccountType"`;

const ADMIN_FROM = `${FROM}
     LEFT JOIN users u ON u.id = r.user_id AND u.deleted_at IS NULL`;

type AdminRawRow = RawRow & {
  requesterId: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterAccountType: string | null;
};

function toAdminRow({
  requesterId,
  requesterName,
  requesterEmail,
  requesterAccountType,
  ...row
}: AdminRawRow): AdminRevocationRequestRow {
  return {
    ...toRow(row),
    requester: requesterId
      ? { id: requesterId, displayName: requesterName ?? '', email: requesterEmail ?? '', accountType: requesterAccountType ?? '' }
      : null,
  };
}

/** คิวรออนุมัติ เก่าก่อน (partial index revocation_requests_pending_idx) ไม่แบ่งหน้า — จำนวนทั้งหมดดูจาก countPendingRevocationRequests */
export async function listPendingRevocationRequests(db: Queryable, limit: number): Promise<AdminRevocationRequestRow[]> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     ${ADMIN_FROM}
     WHERE r.status = 'pending'
     ORDER BY r.created_at, r.id
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(toAdminRow);
}

export async function countPendingRevocationRequests(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM certificate_revocation_requests WHERE status = 'pending'`,
  );
  return result.rows[0]!.n;
}

/** ประวัติที่ปิดแล้ว ล่าสุดก่อน — keyset pagination ด้วย id (uuidv7 เรียงตามเวลา), ดึงเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไป */
export async function searchClosedRevocationRequests(
  db: Queryable,
  filter: { status: Exclude<RevocationRequestStatus, 'pending'> | null; afterId: string | null; limit: number },
): Promise<{ rows: AdminRevocationRequestRow[]; nextCursor: string | null }> {
  const result = await db.query<AdminRawRow>(
    `SELECT ${ADMIN_COLUMNS}
     ${ADMIN_FROM}
     WHERE r.status <> 'pending'
       AND ($1::text IS NULL OR r.status = $1)
       AND ($2::uuid IS NULL OR r.id < $2)
     ORDER BY r.id DESC
     LIMIT $3`,
    [filter.status, filter.afterId, filter.limit + 1],
  );
  const rows = result.rows.slice(0, filter.limit).map(toAdminRow);
  const nextCursor = result.rows.length > filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}
