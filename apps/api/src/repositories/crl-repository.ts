import type { Queryable } from '../db/types.js';
import type { RevocationReason } from './certificate-repository.js';

/**
 * ล็อกการออก CRL ทั้งระบบจนจบ transaction (advisory lock ไม่ผูกกับแถวใด)
 * กันการออก 2 ฉบับพร้อมกัน (เพิกถอนพร้อมกัน / job ของ API หลาย instance) ซึ่งจะได้เลข CRL ชนกัน
 * hashtext() แปลงชื่อเป็นเลขของ lock — ชื่อเฉพาะระบบนี้ ไม่ชนกับ lock อื่น
 */
export async function lockCrlIssuance(db: Queryable): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('msumyid:crl-issuance'))`);
}

export type CrlState = {
  /** null = ยังไม่เคยออก CRL */
  latest: { crlNumber: bigint; thisUpdate: Date; revokedCount: number } | null;
  /** จำนวนใบที่ถูกเพิกถอนในขณะนี้ */
  revokedNow: number;
};

/**
 * สถานะสำหรับตัดสินว่าต้องออก CRL ใหม่หรือไม่ (ไม่ดึง crl_der)
 * - ฉบับล่าสุด: ORDER BY crl_number DESC LIMIT 1 ใช้ unique index ของ crl_number
 * - จำนวนใบที่เพิกถอนตอนนี้: ใบที่เพิกถอนแล้วไม่มีทางกลับมาใช้ได้ จำนวนจึงเพิ่มขึ้นอย่างเดียว
 *   มากกว่า revoked_count ของฉบับล่าสุด = มีการเพิกถอนที่ยังไม่อยู่ใน CRL
 * crl_number เป็น bigint ซึ่ง pg คืนเป็น string จึงแปลงเป็น BigInt
 */
export async function getCrlState(db: Queryable): Promise<CrlState> {
  const result = await db.query<{
    crl_number: string | null;
    this_update: Date | null;
    revoked_count: number | null;
    revoked_now: number;
  }>(
    `SELECT latest.crl_number, latest.this_update, latest.revoked_count,
            (SELECT count(*)::int FROM certificates WHERE revoked_at IS NOT NULL) AS revoked_now
     FROM (SELECT 1) AS one
     LEFT JOIN LATERAL (
       SELECT crl_number, this_update, revoked_count
       FROM crls
       ORDER BY crl_number DESC
       LIMIT 1
     ) AS latest ON true`,
  );
  const row = result.rows[0]!;
  return {
    latest:
      row.crl_number === null
        ? null
        : { crlNumber: BigInt(row.crl_number), thisUpdate: row.this_update!, revokedCount: row.revoked_count! },
    revokedNow: row.revoked_now,
  };
}

export type RevokedCertificateRow = {
  serialNumber: string;
  revokedAt: Date;
  reason: RevocationReason;
  notAfter: Date;
};

/**
 * ใบที่ถูกเพิกถอนทั้งหมด (CRL ต้องมีครบทุกใบ) — LIMIT กันดึงข้อมูลมหาศาลโดยไม่ตั้งใจ
 * ผู้เรียกขอ limit + 1 แถวเพื่อรู้ว่าเกินขีดจำกัดหรือไม่ (เกิน = ต้องทบทวนการออกแบบ ไม่ใช่ตัดรายการทิ้ง)
 */
export async function listRevokedCertificates(db: Queryable, limit: number): Promise<RevokedCertificateRow[]> {
  const result = await db.query<RevokedCertificateRow>(
    `SELECT serial_number      AS "serialNumber",
            revoked_at         AS "revokedAt",
            revocation_reason  AS reason,
            not_after          AS "notAfter"
     FROM certificates
     WHERE revoked_at IS NOT NULL
     ORDER BY revoked_at, serial_number
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function insertCrl(
  db: Queryable,
  input: { crlNumber: bigint; thisUpdate: Date; nextUpdate: Date; revokedCount: number; crlDer: Buffer },
): Promise<void> {
  await db.query(
    `INSERT INTO crls (crl_number, this_update, next_update, revoked_count, crl_der)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.crlNumber.toString(), input.thisUpdate, input.nextUpdate, input.revokedCount, input.crlDer],
  );
}

export type PublishedCrl = { crlNumber: bigint; thisUpdate: Date; nextUpdate: Date; crlDer: Buffer };

/** CRL ฉบับล่าสุดสำหรับเผยแพร่ — null = ยังไม่เคยออก */
export async function findLatestCrl(db: Queryable): Promise<PublishedCrl | null> {
  const result = await db.query<{ crl_number: string; this_update: Date; next_update: Date; crl_der: Buffer }>(
    `SELECT crl_number, this_update, next_update, crl_der
     FROM crls
     ORDER BY crl_number DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  return row
    ? { crlNumber: BigInt(row.crl_number), thisUpdate: row.this_update, nextUpdate: row.next_update, crlDer: row.crl_der }
    : null;
}
