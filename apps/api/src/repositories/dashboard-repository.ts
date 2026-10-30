import type { Queryable } from '../db/types.js';

// ตัวเลขของหน้า "จัดการระบบ" (/admin) — นับอย่างเดียว ไม่คืนข้อมูลรายบุคคล
// ใช้ count(*) FILTER (WHERE ...) ให้ได้หลายตัวเลขจากการอ่านตารางรอบเดียว

/** บัญชีรออนุมัติ — เงื่อนไขเดียวกับตัวกรอง status=pending ของหน้ารายชื่อผู้ใช้ (ใช้ partial index users_pending_idx) */
export async function countPendingUserApprovals(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM users
     WHERE approval_status = 'pending' AND is_active AND deleted_at IS NULL`,
  );
  return result.rows[0]!.n;
}

export type UserStats = {
  /** ใช้งานได้ (อนุมัติแล้วและไม่ถูกปิด) */
  active: number;
  /** สร้างบัญชีตั้งแต่ since */
  createdSince: number;
  /** รอจำแนกประเภท (ยังไม่ถูกปิด) */
  unclassified: number;
  /** ถูกปิดบัญชี */
  inactive: number;
};

/** สถิติผู้ใช้ — อ่านทั้งตาราง users (ไม่รวมบัญชีที่ลบแล้ว) รอบเดียว ตารางมีหลักพันถึงหมื่นแถว */
export async function getUserStats(db: Queryable, since: Date): Promise<UserStats> {
  const result = await db.query<UserStats>(
    `SELECT count(*) FILTER (WHERE is_active AND approval_status = 'approved')::int AS active,
            count(*) FILTER (WHERE created_at >= $1)::int                          AS "createdSince",
            count(*) FILTER (WHERE is_active AND account_type = 'unclassified')::int AS unclassified,
            count(*) FILTER (WHERE NOT is_active)::int                              AS inactive
     FROM users
     WHERE deleted_at IS NULL`,
    [since],
  );
  return result.rows[0]!;
}

export type CertificateStats = {
  /** ใบประจำตัวที่ใช้งานได้ตอนนี้ (ไม่ถูกเพิกถอนและอยู่ในช่วงอายุ) */
  activePrimary: number;
  activeSupplementary: number;
  /** ใช้งานได้แต่จะหมดอายุภายใน expiringBefore */
  expiringSoon: number;
  /** ระบบออกใหม่ตั้งแต่ since (ไม่นับใบที่นำเข้าจากระบบเดิม) */
  issuedSince: number;
  /** ถูกเพิกถอนตั้งแต่ since */
  revokedSince: number;
};

/**
 * สถิติใบรับรอง — อ่านทั้งตาราง certificates รอบเดียว (ไม่มี soft delete)
 * $1 = เวลาปัจจุบัน, $2 = ต้นช่วงสถิติ, $3 = เส้นตัด "ใกล้หมดอายุ"
 */
export async function getCertificateStats(
  db: Queryable,
  input: { now: Date; since: Date; expiringBefore: Date },
): Promise<CertificateStats> {
  const result = await db.query<CertificateStats>(
    `SELECT count(*) FILTER (WHERE kind = 'primary' AND revoked_at IS NULL
                               AND not_before <= $1 AND not_after > $1)::int              AS "activePrimary",
            count(*) FILTER (WHERE kind = 'supplementary' AND revoked_at IS NULL
                               AND not_before <= $1 AND not_after > $1)::int              AS "activeSupplementary",
            count(*) FILTER (WHERE revoked_at IS NULL
                               AND not_before <= $1 AND not_after > $1 AND not_after <= $3)::int AS "expiringSoon",
            count(*) FILTER (WHERE source = 'issued' AND created_at >= $2)::int          AS "issuedSince",
            count(*) FILTER (WHERE revoked_at >= $2)::int                                 AS "revokedSince"
     FROM certificates`,
    [input.now, input.since, input.expiringBefore],
  );
  return result.rows[0]!;
}

export type LatestCrlInfo = { crlNumber: bigint; thisUpdate: Date; nextUpdate: Date };

/** เลขและอายุของ CRL ฉบับล่าสุด (ไม่ดึง crl_der) — null = ยังไม่เคยออก */
export async function findLatestCrlInfo(db: Queryable): Promise<LatestCrlInfo | null> {
  const result = await db.query<{ crl_number: string; this_update: Date; next_update: Date }>(
    `SELECT crl_number, this_update, next_update
     FROM crls
     ORDER BY crl_number DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  return row ? { crlNumber: BigInt(row.crl_number), thisUpdate: row.this_update, nextUpdate: row.next_update } : null;
}

export type SigningQueueStats = {
  /** รอ worker หยิบ */
  pending: number;
  /** worker กำลังทำ */
  signing: number;
  /** เวลาสร้างของงานที่ยังไม่จบที่เก่าที่สุด — null = ไม่มีงานค้าง */
  oldestOpenAt: Date | null;
  /** ล้มเหลวตั้งแต่ failedSince */
  failedSince: number;
};

/**
 * คิวงานลงนาม — WHERE ตัดเหลือเฉพาะงานที่ยังไม่จบ (partial index ของ pending/signing)
 * กับงานที่ล้มเหลวในช่วงล่าสุด จึงไม่ต้องอ่านงานที่สำเร็จแล้วทั้งหมด
 */
export async function getSigningQueueStats(db: Queryable, failedSince: Date): Promise<SigningQueueStats> {
  const result = await db.query<SigningQueueStats>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int                      AS pending,
            count(*) FILTER (WHERE status = 'signing')::int                      AS signing,
            min(created_at) FILTER (WHERE status IN ('pending', 'signing'))      AS "oldestOpenAt",
            count(*) FILTER (WHERE status = 'failed')::int                       AS "failedSince"
     FROM signing_jobs
     WHERE status IN ('pending', 'signing')
        OR (status = 'failed' AND updated_at >= $1)`,
    [failedSince],
  );
  return result.rows[0]!;
}
