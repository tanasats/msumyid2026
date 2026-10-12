import type { Queryable } from '../db/types.js';

export type CertificateStatus = 'active' | 'expired' | 'revoked';

export type RevocationReason =
  | 'unspecified'
  | 'keyCompromise'
  | 'CACompromise'
  | 'affiliationChanged'
  | 'superseded'
  | 'cessationOfOperation';

export type CertificateRow = {
  id: string;
  serialNumber: string;
  subjectCn: string;
  email: string;
  notBefore: Date;
  notAfter: Date;
  status: CertificateStatus;
  revokedAt: Date | null;
  revocationReason: RevocationReason | null;
  source: 'issued' | 'imported';
  fingerprintSha256: string;
  /** มี key สำรอง = กู้ key / ดาวน์โหลด .p12 ใหม่ได้ (ใบที่นำเข้าโดยไม่มี key เดิมจะไม่มี) */
  hasKeyEscrow: boolean;
  createdAt: Date;
};

// สถานะคำนวณจากเวลาปัจจุบันทุกครั้ง (ไม่เก็บเป็นคอลัมน์ เพราะ "หมดอายุ" เปลี่ยนเองตามเวลา)
// เพิกถอนแล้วมาก่อนหมดอายุ: ใบที่ถูกเพิกถอนต้องแสดงว่าเพิกถอน แม้จะหมดอายุแล้ว
const STATUS_SQL = `CASE
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.not_after <= now()     THEN 'expired'
    ELSE 'active'
  END`;

/**
 * ใบรับรองของผู้ใช้ ล่าสุดก่อน (ใช้ index certificates_user_id_idx)
 * ไม่ส่ง certificate_pem / ข้อมูล escrow — หน้ารายการไม่ต้องใช้
 */
export async function listCertificatesByUser(db: Queryable, userId: string, limit: number): Promise<CertificateRow[]> {
  const result = await db.query<CertificateRow>(
    `SELECT c.id,
            c.serial_number       AS "serialNumber",
            c.subject_cn          AS "subjectCn",
            c.email,
            c.not_before          AS "notBefore",
            c.not_after           AS "notAfter",
            ${STATUS_SQL}         AS status,
            c.revoked_at          AS "revokedAt",
            c.revocation_reason   AS "revocationReason",
            c.source,
            c.fingerprint_sha256  AS "fingerprintSha256",
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS "hasKeyEscrow",
            c.created_at          AS "createdAt"
     FROM certificates c
     WHERE c.user_id = $1
     ORDER BY c.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

/**
 * นับใบที่ใช้งานอยู่ (ยังไม่เพิกถอนและยังไม่หมดอายุ) ของผู้ใช้ — ใช้บังคับจำนวนใบสูงสุดต่อคน
 * ต้องเรียกหลัง lockUserForCertificate ใน transaction เดียวกัน จึงจะนับได้ถูกต้องเมื่อขอพร้อมกันหลายคำขอ
 */
export async function countActiveCertificatesByUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM certificates
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND not_after > now()`,
    [userId],
  );
  return result.rows[0]!.count;
}

/**
 * ล็อกแถวผู้ใช้ไว้ตลอดการออกใบรับรอง (FOR UPDATE) — คำขอพร้อมกันของผู้ใช้คนเดียวกันต้องรอคิว
 * กันกดขอ 2 แท็บพร้อมกันแล้วได้ใบเกินจำนวนสูงสุด
 * คืน false ถ้าไม่พบผู้ใช้ (ถูกลบไปแล้ว)
 */
export async function lockUserForCertificate(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM users
     WHERE id = $1
       AND deleted_at IS NULL
     FOR UPDATE`,
    [userId],
  );
  return result.rowCount === 1;
}

export type InsertCertificateInput = {
  userId: string | null;
  serialNumber: string;
  subjectCn: string;
  email: string;
  notBefore: Date;
  notAfter: Date;
  source: 'issued' | 'imported';
  certificatePem: string;
  fingerprintSha256: string;
  /** ใบที่นำเข้าซึ่งถูกเพิกถอนในระบบเดิมแล้ว (ระบบออกใบใหม่ไม่ใช้) */
  revokedAt?: Date | null;
  revocationReason?: RevocationReason | null;
};

export async function insertCertificate(db: Queryable, input: InsertCertificateInput): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               source, certificate_pem, fingerprint_sha256, revoked_at, revocation_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      input.userId,
      input.serialNumber,
      input.subjectCn,
      input.email,
      input.notBefore,
      input.notAfter,
      input.source,
      input.certificatePem,
      input.fingerprintSha256,
      input.revokedAt ?? null,
      input.revocationReason ?? null,
    ],
  );
  return result.rows[0]!;
}

/** เก็บ key สำรองที่ signer เข้ารหัสมาแล้ว (ฐานข้อมูลถอดเองไม่ได้) */
export async function insertKeyEscrow(
  db: Queryable,
  input: { certificateId: string; kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer },
): Promise<void> {
  await db.query(
    `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id)
     VALUES ($1, $2, $3, $4)`,
    [input.certificateId, input.encryptedKey, input.wrappedDataKey, input.kekId],
  );
}

export type CertificateAuditAction = 'issue' | 'recover' | 'revoke' | 'import' | 'sign';

export async function insertCertificateAuditLog(
  db: Queryable,
  input: { certificateId: string; actorId: string | null; action: CertificateAuditAction; reason: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO certificate_audit_logs (certificate_id, actor_id, action, reason)
     VALUES ($1, $2, $3, $4)`,
    [input.certificateId, input.actorId, input.action, input.reason],
  );
}

export type CertificateForRevocation = {
  id: string;
  userId: string | null;
  serialNumber: string;
  revokedAt: Date | null;
  notAfter: Date;
};

/**
 * อ่านใบรับรองพร้อมล็อกแถว (FOR UPDATE) ก่อนเพิกถอน — กันการเพิกถอนซ้อนกัน 2 คำขอ
 * ไม่กรองเจ้าของใน SQL: service ตรวจและตอบ "ไม่พบ" เหมือนกันทั้งใบที่ไม่มีอยู่และใบของคนอื่น
 */
export async function findCertificateForUpdate(db: Queryable, id: string): Promise<CertificateForRevocation | null> {
  const result = await db.query<CertificateForRevocation>(
    `SELECT id,
            user_id        AS "userId",
            serial_number  AS "serialNumber",
            revoked_at     AS "revokedAt",
            not_after      AS "notAfter"
     FROM certificates
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * เพิกถอนใบรับรอง — เงื่อนไข revoked_at IS NULL กันเขียนทับเวลาเพิกถอนเดิม (ย้อนกลับไม่ได้)
 * คืน false ถ้าใบถูกเพิกถอนไปแล้ว
 */
export async function revokeCertificate(
  db: Queryable,
  input: { id: string; reason: RevocationReason; revokedBy: string | null; revokedAt?: Date },
): Promise<boolean> {
  // revokedAt ไม่ส่ง = เวลาปัจจุบัน (ส่งเฉพาะตอนนำเข้าการเพิกถอนจากระบบเดิม เพื่อคงวันเพิกถอนเดิมไว้ใน CRL)
  const result = await db.query(
    `UPDATE certificates
     SET revoked_at = COALESCE($4, now()), revocation_reason = $2, revoked_by = $3
     WHERE id = $1
       AND revoked_at IS NULL`,
    [input.id, input.reason, input.revokedBy, input.revokedAt ?? null],
  );
  return result.rowCount === 1;
}

export type CertificateWithEscrow = {
  id: string;
  userId: string | null;
  serialNumber: string;
  email: string;
  certificatePem: string;
  /** เหตุผลการเพิกถอน (null = ยังไม่ถูกเพิกถอน) — keyCompromise ห้ามสร้าง .p12 ใหม่ */
  revocationReason: RevocationReason | null;
  /** null = ไม่มี key สำรอง */
  escrow: { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer } | null;
};

/**
 * ใบรับรองพร้อม key สำรอง (ที่ยังเข้ารหัสอยู่) สำหรับส่งให้ signer สร้าง .p12 ใหม่
 * LEFT JOIN: ใบที่ไม่มี key สำรองยังได้แถวกลับมา (escrow = null) เพื่อแยกตอบ "ไม่พบใบ" กับ "ไม่มี key สำรอง"
 */
export async function findCertificateWithEscrow(db: Queryable, id: string): Promise<CertificateWithEscrow | null> {
  const result = await db.query<{
    id: string;
    user_id: string | null;
    serial_number: string;
    email: string;
    certificate_pem: string;
    revocation_reason: RevocationReason | null;
    kek_id: string | null;
    encrypted_key: Buffer | null;
    wrapped_data_key: Buffer | null;
  }>(
    `SELECT c.id, c.user_id, c.serial_number, c.email, c.certificate_pem, c.revocation_reason,
            e.kek_id, e.encrypted_key, e.wrapped_data_key
     FROM certificates c
     LEFT JOIN certificate_key_escrows e ON e.certificate_id = c.id
     WHERE c.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    serialNumber: row.serial_number,
    email: row.email,
    certificatePem: row.certificate_pem,
    revocationReason: row.revocation_reason,
    escrow:
      row.kek_id && row.encrypted_key && row.wrapped_data_key
        ? { kekId: row.kek_id, encryptedKey: row.encrypted_key, wrappedDataKey: row.wrapped_data_key }
        : null,
  };
}

export type ExistingCertificate = {
  id: string;
  serialNumber: string;
  source: 'issued' | 'imported';
  revokedAt: Date | null;
  hasKeyEscrow: boolean;
};

/**
 * ใบที่มีอยู่แล้วตาม serial (สคริปต์นำเข้าใช้ข้ามใบที่เคยนำเข้า) — ใช้ unique index ของ serial_number
 * จำนวนแถวไม่เกินจำนวน serial ที่ส่งมา (ผู้เรียกแบ่งเป็นชุดเอง)
 */
export async function findCertificatesBySerials(db: Queryable, serials: string[]): Promise<ExistingCertificate[]> {
  const result = await db.query<ExistingCertificate>(
    `SELECT c.id,
            c.serial_number  AS "serialNumber",
            c.source,
            c.revoked_at     AS "revokedAt",
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS "hasKeyEscrow"
     FROM certificates c
     WHERE c.serial_number = ANY($1::text[])`,
    [serials],
  );
  return result.rows;
}

/**
 * ผูกใบที่นำเข้าแล้วยังไม่มีเจ้าของ (user_id IS NULL) กับผู้ใช้ที่ login ด้วยอีเมลเดียวกัน
 * ใช้ partial index certificates_unowned_email_idx — คืนจำนวนใบที่ผูก
 */
export async function claimUnownedCertificates(db: Queryable, userId: string, email: string): Promise<number> {
  const result = await db.query(
    `UPDATE certificates
     SET user_id = $1
     WHERE user_id IS NULL
       AND lower(email) = lower($2)`,
    [userId, email],
  );
  return result.rowCount ?? 0;
}

// ---- ผู้ดูแล ----

export type CertificateSearchFilter = {
  /** ชื่อในใบ / อีเมล (บางส่วน) */
  q: string | null;
  /** serial ที่แปลงเป็นรูปแบบในฐานข้อมูลแล้ว (เทียบตรงตัว) — null = ข้อความค้นหาไม่ใช่ serial */
  serial: string | null;
  status: CertificateStatus | null;
  /** id ของแถวสุดท้ายในหน้าก่อน (keyset pagination) */
  afterId: string | null;
  limit: number;
};

export type AdminCertificateRow = CertificateRow & {
  owner: { id: string; displayName: string } | null;
};

/** escape อักขระพิเศษของ LIKE (\ % _) เพื่อให้ค้นหาตามตัวอักษรจริง */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * ค้นหาใบรับรองทั้งระบบสำหรับผู้ดูแล — ตัวกรองแบบ "($n IS NULL OR เงื่อนไข)"
 * - ข้อความ: subject_cn ILIKE / lower(email) LIKE ใช้ trigram index, serial เทียบตรงตัวด้วย unique index
 * - สถานะ: เงื่อนไขเดียวกับ STATUS_SQL (เพิกถอนมาก่อนหมดอายุ)
 * - เจ้าของ: LEFT JOIN เพราะใบที่นำเข้าอาจยังไม่มีเจ้าของ (ไม่แสดงเจ้าของที่ถูกลบบัญชีแล้ว)
 * - keyset pagination ด้วย id (uuidv7 เรียงตามเวลาสร้าง) ดึงเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไป
 */
export async function searchCertificates(
  db: Queryable,
  filter: CertificateSearchFilter,
): Promise<{ rows: AdminCertificateRow[]; nextCursor: string | null }> {
  const result = await db.query<CertificateRow & { ownerId: string | null; ownerName: string | null }>(
    `SELECT c.id,
            c.serial_number       AS "serialNumber",
            c.subject_cn          AS "subjectCn",
            c.email,
            c.not_before          AS "notBefore",
            c.not_after           AS "notAfter",
            ${STATUS_SQL}         AS status,
            c.revoked_at          AS "revokedAt",
            c.revocation_reason   AS "revocationReason",
            c.source,
            c.fingerprint_sha256  AS "fingerprintSha256",
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS "hasKeyEscrow",
            c.created_at          AS "createdAt",
            u.id                  AS "ownerId",
            u.display_name        AS "ownerName"
     FROM certificates c
     LEFT JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL
     WHERE ($1::text IS NULL OR c.subject_cn ILIKE $1 OR lower(c.email) LIKE lower($1) OR c.serial_number = $2)
       AND ($3::text IS NULL
            OR ($3 = 'revoked' AND c.revoked_at IS NOT NULL)
            OR ($3 = 'expired' AND c.revoked_at IS NULL AND c.not_after <= now())
            OR ($3 = 'active'  AND c.revoked_at IS NULL AND c.not_after > now()))
       AND ($4::uuid IS NULL OR c.id < $4)
     ORDER BY c.id DESC
     LIMIT $5`,
    [filter.q ? likePattern(filter.q) : null, filter.serial, filter.status, filter.afterId, filter.limit + 1],
  );
  const rows = result.rows.slice(0, filter.limit).map(({ ownerId, ownerName, ...row }) => ({
    ...row,
    owner: ownerId ? { id: ownerId, displayName: ownerName ?? '' } : null,
  }));
  const nextCursor = result.rows.length > filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}

/**
 * เพิกถอนใบที่ยังใช้งานอยู่ทั้งหมดของผู้ใช้ (ปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ) — คืน id ของใบที่เพิกถอน
 * ใบที่หมดอายุแล้วไม่ต้องเพิกถอน (ไม่ต้องอยู่ใน CRL)
 */
export async function revokeActiveCertificatesByUser(
  db: Queryable,
  input: { userId: string; reason: RevocationReason; revokedBy: string | null },
): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `UPDATE certificates
     SET revoked_at = now(), revocation_reason = $2, revoked_by = $3
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND not_after > now()
     RETURNING id`,
    [input.userId, input.reason, input.revokedBy],
  );
  return result.rows.map((r) => r.id);
}

/**
 * ลบข้อมูลส่วนบุคคลในใบรับรองของผู้ใช้ที่ถูกลบบัญชี (PDPA)
 * - ลบ key สำรอง (private key ของบุคคล — กู้ไม่ได้อีก)
 * - ล้างชื่อ อีเมล และตัวใบรับรอง (มีชื่อ/อีเมลอยู่ใน subject)
 * - คงแถวไว้พร้อม serial, วันหมดอายุ และการเพิกถอน เพราะ CRL ยังต้องใช้
 */
export async function erasePersonalDataFromCertificates(
  db: Queryable,
  userId: string,
): Promise<{ certificates: number; keyEscrows: number }> {
  const escrows = await db.query(
    `DELETE FROM certificate_key_escrows
     WHERE certificate_id IN (SELECT id FROM certificates WHERE user_id = $1)`,
    [userId],
  );
  const certificates = await db.query(
    `UPDATE certificates
     SET subject_cn = '', email = '', certificate_pem = ''
     WHERE user_id = $1`,
    [userId],
  );
  return { certificates: certificates.rowCount ?? 0, keyEscrows: escrows.rowCount ?? 0 };
}

/** เจ้าของใบ (ไม่ล็อก) — ใช้หาว่าต้องล็อกผู้ใช้คนไหนก่อนล็อกใบ (ลำดับล็อก ผู้ใช้ → ใบ เหมือนการปิดบัญชี) */
export async function findCertificateOwnerId(db: Queryable, id: string): Promise<{ userId: string | null } | null> {
  const result = await db.query<{ userId: string | null }>(
    `SELECT user_id AS "userId" FROM certificates WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
