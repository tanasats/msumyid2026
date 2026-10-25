import type { Queryable } from '../db/types.js';
import type { CertificateKind, RevocationReason } from './certificate-repository.js';
import type { AccountType, ApprovalStatus } from './session-repository.js';

// ชุดการลงนาม (signing_batches) และงานลงนามทีละไฟล์ (signing_jobs) — docs/design/document-signing.md

export type SigningBatchStatus = 'processing' | 'completed' | 'failed';
export type SigningJobStatus = 'pending' | 'signing' | 'signed' | 'failed';

export type SigningBatchRow = {
  id: string;
  userId: string;
  certificateId: string;
  source: 'single' | 'zip';
  lockDocument: boolean;
  status: SigningBatchStatus;
  expiresAt: Date;
  createdAt: Date;
};

export type SigningJobRow = {
  id: string;
  batchId: string;
  originalName: string;
  status: SigningJobStatus;
  errorCode: string | null;
  signedFileId: string | null;
  documentSha256: string | null;
  signedSha256: string | null;
  signedAt: Date | null;
};

const BATCH_COLUMNS = `b.id,
            b.user_id        AS "userId",
            b.certificate_id AS "certificateId",
            b.source,
            b.lock_document  AS "lockDocument",
            b.status,
            b.expires_at     AS "expiresAt",
            b.created_at     AS "createdAt"`;

const JOB_COLUMNS = `j.id,
            j.batch_id        AS "batchId",
            j.original_name   AS "originalName",
            j.status,
            j.error_code      AS "errorCode",
            j.signed_file_id  AS "signedFileId",
            j.document_sha256 AS "documentSha256",
            j.signed_sha256   AS "signedSha256",
            j.signed_at       AS "signedAt"`;

/**
 * signing_batches.appearance (jsonb): มองไม่เห็น = { visible: false }
 * มองเห็น = ตำแหน่งเป็นสัดส่วนของหน้าที่แสดงผล + ภาพลายเซ็น ณ ตอนส่งคำขอ (imageFileId, null = ข้อความอย่างเดียว)
 */
export type SigningAppearance =
  | { visible: false }
  | { visible: true; page: number; x: number; y: number; w: number; h: number; showText: boolean; imageFileId: string | null };

export async function insertSigningBatch(
  db: Queryable,
  input: {
    userId: string;
    certificateId: string;
    source: 'single' | 'zip';
    lockDocument: boolean;
    appearance: SigningAppearance;
    expiresAt: Date;
  },
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO signing_batches (user_id, certificate_id, source, lock_document, appearance, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [input.userId, input.certificateId, input.source, input.lockDocument, JSON.stringify(input.appearance), input.expiresAt],
  );
  return result.rows[0]!;
}

export async function insertSigningJob(
  db: Queryable,
  input: { batchId: string; sourceFileId: string; originalName: string },
): Promise<{ id: string }> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO signing_jobs (batch_id, source_file_id, original_name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [input.batchId, input.sourceFileId, input.originalName],
  );
  return result.rows[0]!;
}

/** ชุดของผู้ใช้ — กรอง user_id ใน SQL: ชุดของคนอื่นได้ null เหมือนชุดที่ไม่มี */
export async function findSigningBatchOfUser(db: Queryable, batchId: string, userId: string): Promise<SigningBatchRow | null> {
  const result = await db.query<SigningBatchRow>(
    `SELECT ${BATCH_COLUMNS}
     FROM signing_batches b
     WHERE b.id = $1
       AND b.user_id = $2`,
    [batchId, userId],
  );
  return result.rows[0] ?? null;
}

/** ไฟล์ในชุด เรียงตามลำดับที่เพิ่ม (id เป็น uuidv7 เรียงตามเวลา) — ชุดหนึ่งมีไม่เกิน 100 ไฟล์ (ZIP) */
export async function listSigningJobsOfBatch(db: Queryable, batchId: string, limit: number): Promise<SigningJobRow[]> {
  const result = await db.query<SigningJobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM signing_jobs j
     WHERE j.batch_id = $1
     ORDER BY j.id
     LIMIT $2`,
    [batchId, limit],
  );
  return result.rows;
}

export type SigningBatchSummaryRow = SigningBatchRow & {
  /** ชื่อไฟล์แรกของชุด (ชุดไฟล์เดียว = ชื่อไฟล์นั้น) */
  firstName: string | null;
  /** ไฟล์ที่ลงนามแล้วไฟล์แรก (ชุดไฟล์เดียวดาวน์โหลดจากหน้าประวัติได้) */
  firstSignedFileId: string | null;
  totalJobs: number;
  signedJobs: number;
  failedJobs: number;
};

/**
 * ชุดล่าสุดของผู้ใช้ (ใช้ index signing_batches_user_id_idx) พร้อมจำนวนไฟล์ตามสถานะ
 * LATERAL: นับงานของแต่ละชุดในแถวเดียว (FILTER แยกนับตามสถานะ) แทนการ query ทีละชุด
 */
export async function listSigningBatchesOfUser(db: Queryable, userId: string, limit: number): Promise<SigningBatchSummaryRow[]> {
  const result = await db.query<SigningBatchSummaryRow>(
    `SELECT ${BATCH_COLUMNS},
            s."firstName",
            s."firstSignedFileId",
            s."totalJobs",
            s."signedJobs",
            s."failedJobs"
     FROM signing_batches b
     CROSS JOIN LATERAL (
       SELECT (ARRAY_AGG(j.original_name ORDER BY j.id))[1]           AS "firstName",
              (ARRAY_AGG(j.signed_file_id ORDER BY j.id)
                 FILTER (WHERE j.status = 'signed'))[1]                   AS "firstSignedFileId",
              COUNT(*)::int                                            AS "totalJobs",
              COUNT(*) FILTER (WHERE j.status = 'signed')::int         AS "signedJobs",
              COUNT(*) FILTER (WHERE j.status = 'failed')::int         AS "failedJobs"
       FROM signing_jobs j
       WHERE j.batch_id = b.id
     ) s
     WHERE b.user_id = $1
     ORDER BY b.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

/**
 * หยิบงานถัดไปจากคิว แล้วตั้งเป็น signing ในคำสั่งเดียว (commit ทันที ไม่ถือ transaction ระหว่างลงนามซึ่งใช้หลายวินาที)
 * subquery ใช้ FOR UPDATE SKIP LOCKED: worker หลายตัวหยิบพร้อมกันได้งานคนละงาน (ใช้ partial index signing_jobs_pending_idx)
 */
export async function claimNextSigningJob(db: Queryable): Promise<{ id: string; attempts: number } | null> {
  const result = await db.query<{ id: string; attempts: number }>(
    `UPDATE signing_jobs
     SET status = 'signing', attempts = attempts + 1, started_at = now()
     WHERE id = (
       SELECT id
       FROM signing_jobs
       WHERE status = 'pending'
         AND run_after <= now()
       ORDER BY run_after
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, attempts`,
  );
  return result.rows[0] ?? null;
}

export type SigningJobContext = {
  jobId: string;
  batchId: string;
  originalName: string;
  lockDocument: boolean;
  appearance: SigningAppearance;
  /** object key ของภาพลายเซ็นที่ชุดนี้ใช้ — null = ไม่ใช้ภาพ หรือไฟล์ภาพถูกลบไปแล้ว (ดู appearance.imageFileId) */
  imageObjectKey: string | null;
  batchExpiresAt: Date;
  user: {
    id: string;
    email: string;
    /** users.display_name — ใส่เป็นชื่อผู้ลงนามใน PDF */
    name: string;
    accountType: AccountType;
    approvalStatus: ApprovalStatus;
    /** is_active และยังไม่ถึงวันหมดอายุของบัญชี และยังไม่ถูกลบ */
    isActive: boolean;
    roles: string[];
    permissions: string[];
  };
  certificate: {
    id: string;
    userId: string | null;
    kind: CertificateKind;
    serialNumber: string;
    certificatePem: string;
    notBefore: Date;
    notAfter: Date;
    revokedAt: Date | null;
    revocationReason: RevocationReason | null;
    escrow: { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer } | null;
  };
  sourceFile: { id: string; objectKey: string; mimeType: string; size: number; deleted: boolean };
};

/**
 * ข้อมูลทั้งหมดที่ worker ต้องใช้ตรวจก่อนลงนาม อ่านใหม่จากฐานข้อมูลตอนลงนาม (ไม่ใช้ค่าตอนส่งคำขอ):
 * สถานะบัญชีและสิทธิ์ล่าสุด (role/permission แบบเดียวกับ findSessionUser), สถานะใบ + key สำรอง, ไฟล์ต้นฉบับ
 * LEFT JOIN escrow: ใบที่ไม่มี key สำรองยังได้แถวกลับมา (escrow = null) เพื่อให้ worker แจ้งเหตุผลได้
 */
export async function findSigningJobContext(db: Queryable, jobId: string): Promise<SigningJobContext | null> {
  const result = await db.query<{
    job_id: string;
    batch_id: string;
    original_name: string;
    lock_document: boolean;
    appearance: SigningAppearance;
    image_object_key: string | null;
    batch_expires_at: Date;
    user_id: string;
    email: string;
    display_name: string;
    account_type: AccountType;
    approval_status: ApprovalStatus;
    is_active: boolean;
    roles: string[];
    permissions: string[];
    certificate_id: string;
    certificate_user_id: string | null;
    kind: CertificateKind;
    serial_number: string;
    certificate_pem: string;
    not_before: Date;
    not_after: Date;
    revoked_at: Date | null;
    revocation_reason: RevocationReason | null;
    kek_id: string | null;
    encrypted_key: Buffer | null;
    wrapped_data_key: Buffer | null;
    file_id: string;
    object_key: string;
    mime_type: string;
    size: number;
    file_deleted: boolean;
  }>(
    `SELECT j.id              AS job_id,
            j.batch_id,
            j.original_name,
            b.lock_document,
            b.appearance,
            img.object_key     AS image_object_key,
            b.expires_at       AS batch_expires_at,
            u.id               AS user_id,
            u.email,
            u.display_name,
            u.account_type,
            u.approval_status,
            (u.is_active AND u.deleted_at IS NULL
              AND (u.account_expires_at IS NULL OR u.account_expires_at > now())) AS is_active,
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
            c.id               AS certificate_id,
            c.user_id          AS certificate_user_id,
            c.kind,
            c.serial_number,
            c.certificate_pem,
            c.not_before,
            c.not_after,
            c.revoked_at,
            c.revocation_reason,
            e.kek_id,
            e.encrypted_key,
            e.wrapped_data_key,
            f.id               AS file_id,
            f.object_key,
            f.mime_type,
            f.size::float8     AS size,
            (f.deleted_at IS NOT NULL OR f.status <> 'uploaded') AS file_deleted
     FROM signing_jobs j
     JOIN signing_batches b ON b.id = j.batch_id
     JOIN users u ON u.id = b.user_id
     JOIN certificates c ON c.id = b.certificate_id
     LEFT JOIN certificate_key_escrows e ON e.certificate_id = c.id
     JOIN files f ON f.id = j.source_file_id
     -- ภาพลายเซ็นที่บันทึกไว้ใน appearance ตอนส่งคำขอ (ไฟล์ถูกลบแล้ว = NULL → worker แจ้งว่าไม่พบภาพ)
     LEFT JOIN files img ON img.id = (b.appearance->>'imageFileId')::uuid AND img.deleted_at IS NULL
     WHERE j.id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    jobId: row.job_id,
    batchId: row.batch_id,
    originalName: row.original_name,
    lockDocument: row.lock_document,
    appearance: row.appearance,
    imageObjectKey: row.image_object_key,
    batchExpiresAt: row.batch_expires_at,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.display_name,
      accountType: row.account_type,
      approvalStatus: row.approval_status,
      isActive: row.is_active,
      roles: row.roles,
      permissions: row.permissions,
    },
    certificate: {
      id: row.certificate_id,
      userId: row.certificate_user_id,
      kind: row.kind,
      serialNumber: row.serial_number,
      certificatePem: row.certificate_pem,
      notBefore: row.not_before,
      notAfter: row.not_after,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      escrow:
        row.kek_id && row.encrypted_key && row.wrapped_data_key
          ? { kekId: row.kek_id, encryptedKey: row.encrypted_key, wrappedDataKey: row.wrapped_data_key }
          : null,
    },
    sourceFile: {
      id: row.file_id,
      objectKey: row.object_key,
      mimeType: row.mime_type,
      size: row.size,
      deleted: row.file_deleted,
    },
  };
}

/** เงื่อนไข status = 'signing' ทุกคำสั่งด้านล่าง: งานที่ถูกคืนเข้าคิว (ค้างนานเกิน) แล้วจะไม่ถูก worker ตัวเดิมเขียนทับ */
export async function markSigningJobSigned(
  db: Queryable,
  input: { jobId: string; signedFileId: string; documentSha256: string; signedSha256: string },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'signed', signed_file_id = $2, document_sha256 = $3, signed_sha256 = $4, signed_at = now(), error_code = NULL
     WHERE id = $1
       AND status = 'signing'`,
    [input.jobId, input.signedFileId, input.documentSha256, input.signedSha256],
  );
  return result.rowCount === 1;
}

export async function markSigningJobFailed(
  db: Queryable,
  input: { jobId: string; errorCode: string; documentSha256?: string | null },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'failed', error_code = $2, document_sha256 = COALESCE($3, document_sha256)
     WHERE id = $1
       AND status = 'signing'`,
    [input.jobId, input.errorCode, input.documentSha256 ?? null],
  );
  return result.rowCount === 1;
}

/** ล้มเหลวชั่วคราว: คืนเข้าคิวให้ลองใหม่หลัง runAfter (เก็บรหัสล่าสุดไว้ดูได้) */
export async function retrySigningJobLater(db: Queryable, input: { jobId: string; errorCode: string; runAfter: Date }): Promise<boolean> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'pending', error_code = $2, run_after = $3
     WHERE id = $1
       AND status = 'signing'`,
    [input.jobId, input.errorCode, input.runAfter],
  );
  return result.rowCount === 1;
}

/**
 * งานที่ค้าง signing นานเกิน (worker ตาย/ถูกปิดกลางทาง): คืนเข้าคิว หรือตั้งล้มเหลวถ้าลองครบจำนวนครั้งแล้ว
 * คืน batch_id ที่ได้รับผล เพื่อให้ผู้เรียกปรับสถานะชุด (ใช้ partial index signing_jobs_signing_idx)
 */
export async function requeueStaleSigningJobs(
  db: Queryable,
  input: { startedBefore: Date; maxAttempts: number; errorCode: string },
): Promise<string[]> {
  const result = await db.query<{ batch_id: string }>(
    `UPDATE signing_jobs
     SET status     = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
         error_code = CASE WHEN attempts >= $2 THEN $3 ELSE error_code END,
         run_after  = now()
     WHERE status = 'signing'
       AND started_at < $1
     RETURNING batch_id`,
    [input.startedBefore, input.maxAttempts, input.errorCode],
  );
  return [...new Set(result.rows.map((r) => r.batch_id))];
}

/**
 * ปิดชุดเมื่อไม่มีงานค้าง (pending/signing) แล้ว: ลงนามได้อย่างน้อย 1 ไฟล์ = completed ไม่เช่นนั้น failed
 * เงื่อนไข status = 'processing' ทำให้เรียกซ้ำได้ไม่มีผล
 */
export async function refreshSigningBatchStatus(db: Queryable, batchId: string): Promise<void> {
  await db.query(
    `UPDATE signing_batches b
     SET status = CASE
                    WHEN EXISTS (SELECT 1 FROM signing_jobs j WHERE j.batch_id = b.id AND j.status = 'signed') THEN 'completed'
                    ELSE 'failed'
                  END
     WHERE b.id = $1
       AND b.status = 'processing'
       AND NOT EXISTS (
         SELECT 1 FROM signing_jobs j WHERE j.batch_id = b.id AND j.status IN ('pending', 'signing')
       )`,
    [batchId],
  );
}

/** ลบบัญชี (PDPA): ล้างชื่อไฟล์ในงานลงนามทั้งหมดของผู้ใช้ — คืนจำนวนแถวที่แก้ */
export async function eraseSigningJobNamesOfUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE signing_jobs j
     SET original_name = 'deleted'
     FROM signing_batches b
     WHERE b.id = j.batch_id
       AND b.user_id = $1
       AND j.original_name <> 'deleted'`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/**
 * ตรวจไม่ผ่านระดับชุด (บัญชีถูกปิด/ใบใช้ไม่ได้): งานที่ยังรอคิวของชุดล้มเหลวด้วยเหตุผลเดียวกัน (ไม่ต้องรอ worker หยิบทีละไฟล์)
 * ใช้ index signing_jobs_batch_id_idx
 */
export async function failPendingJobsOfBatch(db: Queryable, input: { batchId: string; errorCode: string }): Promise<number> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'failed', error_code = $2
     WHERE batch_id = $1
       AND status = 'pending'`,
    [input.batchId, input.errorCode],
  );
  return result.rowCount ?? 0;
}

export type SigningCertificateRow = {
  id: string;
  userId: string | null;
  notBefore: Date;
  notAfter: Date;
  revokedAt: Date | null;
  hasKeyEscrow: boolean;
};

/** ใบที่จะใช้ลงนาม (ตรวจตอนส่งคำขอ — worker ตรวจซ้ำตอนลงนาม) ไม่อ่าน key สำรองมาด้วย */
export async function findSigningCertificate(db: Queryable, id: string): Promise<SigningCertificateRow | null> {
  const result = await db.query<SigningCertificateRow>(
    `SELECT c.id,
            c.user_id     AS "userId",
            c.not_before  AS "notBefore",
            c.not_after   AS "notAfter",
            c.revoked_at  AS "revokedAt",
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS "hasKeyEscrow"
     FROM certificates c
     WHERE c.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
