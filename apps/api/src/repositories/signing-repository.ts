import type { Queryable } from '../db/types.js';
import type { CertificateKind, RevocationReason } from './certificate-repository.js';
import type { AccountType, ApprovalStatus } from './session-repository.js';

// ชุดการลงนาม (signing_batches) และงานลงนามทีละไฟล์ (signing_jobs) — docs/design/document-signing.md

/** extracting = รอ/กำลังแตก ZIP (ชุดแบบ zip) */
export type SigningBatchStatus = 'extracting' | 'processing' | 'completed' | 'failed';
export type SigningJobStatus = 'pending' | 'signing' | 'signed' | 'failed';

export type SigningBatchRow = {
  id: string;
  userId: string;
  certificateId: string;
  source: 'single' | 'zip';
  lockDocument: boolean;
  status: SigningBatchStatus;
  /** ชื่อไฟล์ ZIP ต้นฉบับ (null = ชุดไฟล์เดียว) */
  zipName: string | null;
  skippedEntries: { name: string; reason: string }[];
  /** เหตุที่ทั้งชุดล้มเหลว (เช่น ZIP เสีย) — null = ดูที่แต่ละไฟล์ */
  errorCode: string | null;
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
  ltvStatus: LtvStatus | null;
};

/** LTV ของไฟล์ที่ลงนามแล้ว (ระยะ D4b) — ดู migration add-ltv-status-to-signing-jobs */
export type LtvStatus = 'embedded' | 'skipped_locked' | 'unavailable';

const BATCH_COLUMNS = `b.id,
            b.user_id        AS "userId",
            b.certificate_id AS "certificateId",
            b.source,
            b.lock_document  AS "lockDocument",
            b.status,
            (SELECT z.original_name FROM files z WHERE z.id = b.source_file_id) AS "zipName",
            b.skipped_entries AS "skippedEntries",
            b.error_code     AS "errorCode",
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
            j.signed_at       AS "signedAt",
            j.ltv_status      AS "ltvStatus"`;

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
    lockDocument: boolean;
    appearance: SigningAppearance;
    expiresAt: Date;
  } & ({ source: 'single' } | { source: 'zip'; zipFileId: string }),
): Promise<{ id: string }> {
  // ชุด zip เริ่มที่ extracting (worker แตกไฟล์ก่อน) ชุดไฟล์เดียวเริ่มที่ processing
  const zip = input.source === 'zip';
  const result = await db.query<{ id: string }>(
    `INSERT INTO signing_batches (user_id, certificate_id, source, lock_document, appearance, expires_at, status, source_file_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.userId,
      input.certificateId,
      input.source,
      input.lockDocument,
      JSON.stringify(input.appearance),
      input.expiresAt,
      zip ? 'extracting' : 'processing',
      zip ? input.zipFileId : null,
    ],
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
  /** ชื่อไฟล์แรกของชุด (ชุดไฟล์เดียว = ชื่อไฟล์นั้น — ชุด ZIP ใช้ zipName) */
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

/** ผู้ลงนาม ณ ตอนที่ worker ทำงาน (สิทธิ์ล่าสุด) */
export type SignerUser = {
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

export type SignerCertificate = {
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

type SignerRow = {
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
};

/**
 * คอลัมน์ผู้ใช้ + ใบรับรอง + key สำรอง ของชุด b (ต้องมี SIGNER_JOINS) — role/permission แบบเดียวกับ findSessionUser
 * LEFT JOIN escrow: ใบที่ไม่มี key สำรองยังได้แถวกลับมา (escrow = null) เพื่อให้ worker แจ้งเหตุผลได้
 */
const SIGNER_COLUMNS = `u.id               AS user_id,
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
            e.wrapped_data_key`;

const SIGNER_JOINS = `JOIN users u ON u.id = b.user_id
     JOIN certificates c ON c.id = b.certificate_id
     LEFT JOIN certificate_key_escrows e ON e.certificate_id = c.id`;

function toSigner(row: SignerRow): { user: SignerUser; certificate: SignerCertificate } {
  return {
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
  };
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
  user: SignerUser;
  certificate: SignerCertificate;
  sourceFile: { id: string; objectKey: string; mimeType: string; size: number; deleted: boolean };
};

/**
 * ข้อมูลทั้งหมดที่ worker ต้องใช้ตรวจก่อนลงนาม อ่านใหม่จากฐานข้อมูลตอนลงนาม (ไม่ใช้ค่าตอนส่งคำขอ):
 * สถานะบัญชีและสิทธิ์ล่าสุด, สถานะใบ + key สำรอง, ไฟล์ต้นฉบับ, ภาพลายเซ็นของชุด
 */
export async function findSigningJobContext(db: Queryable, jobId: string): Promise<SigningJobContext | null> {
  const result = await db.query<
    SignerRow & {
      job_id: string;
      batch_id: string;
      original_name: string;
      lock_document: boolean;
      appearance: SigningAppearance;
      image_object_key: string | null;
      batch_expires_at: Date;
      file_id: string;
      object_key: string;
      mime_type: string;
      size: number;
      file_deleted: boolean;
    }
  >(
    `SELECT j.id              AS job_id,
            j.batch_id,
            j.original_name,
            b.lock_document,
            b.appearance,
            img.object_key     AS image_object_key,
            b.expires_at       AS batch_expires_at,
            ${SIGNER_COLUMNS},
            f.id               AS file_id,
            f.object_key,
            f.mime_type,
            f.size::float8     AS size,
            (f.deleted_at IS NOT NULL OR f.status <> 'uploaded') AS file_deleted
     FROM signing_jobs j
     JOIN signing_batches b ON b.id = j.batch_id
     ${SIGNER_JOINS}
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
    ...toSigner(row),
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
  input: { jobId: string; signedFileId: string; documentSha256: string; signedSha256: string; ltvStatus: LtvStatus },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'signed', signed_file_id = $2, document_sha256 = $3, signed_sha256 = $4, signed_at = now(), error_code = NULL,
         ltv_status = $5
     WHERE id = $1
       AND status = 'signing'`,
    [input.jobId, input.signedFileId, input.documentSha256, input.signedSha256, input.ltvStatus],
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

/** ลบบัญชี (PDPA): ล้างชื่อไฟล์ในงานลงนามและรายการที่ข้ามใน ZIP ของผู้ใช้ — คืนจำนวนงานที่แก้ */
export async function eraseSigningJobNamesOfUser(db: Queryable, userId: string): Promise<number> {
  await db.query(
    `UPDATE signing_batches SET skipped_entries = '[]'::jsonb WHERE user_id = $1 AND skipped_entries <> '[]'::jsonb`,
    [userId],
  );
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

/**
 * หยิบชุด ZIP ถัดไปที่รอแตก (ใช้ partial index signing_batches_extracting_idx) แล้วตั้งเวลาเริ่มในคำสั่งเดียว
 * หยิบได้เมื่อยังไม่มีใครทำ (extract_started_at NULL) หรือค้างเกิน staleBefore (worker ตายกลางทาง) — FOR UPDATE SKIP LOCKED กันหยิบซ้ำ
 */
export async function claimNextExtraction(db: Queryable, staleBefore: Date): Promise<{ id: string; attempts: number } | null> {
  const result = await db.query<{ id: string; attempts: number }>(
    `UPDATE signing_batches
     SET extract_attempts = extract_attempts + 1, extract_started_at = now()
     WHERE id = (
       SELECT id
       FROM signing_batches
       WHERE status = 'extracting'
         AND extract_run_after <= now()
         AND (extract_started_at IS NULL OR extract_started_at < $1)
       ORDER BY extract_run_after
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, extract_attempts AS attempts`,
    [staleBefore],
  );
  return result.rows[0] ?? null;
}

export type ExtractionContext = {
  batchId: string;
  batchExpiresAt: Date;
  user: SignerUser;
  certificate: SignerCertificate;
  zip: { id: string; objectKey: string; size: number; deleted: boolean };
};

/** ข้อมูลที่ต้องใช้แตก ZIP ของชุด — ผู้ใช้/ใบอ่านใหม่ตอนแตกไฟล์ (ตรวจสิทธิ์ก่อนแตก) */
export async function findExtractionContext(db: Queryable, batchId: string): Promise<ExtractionContext | null> {
  const result = await db.query<
    SignerRow & { batch_id: string; batch_expires_at: Date; zip_id: string; object_key: string; size: number; zip_deleted: boolean }
  >(
    `SELECT b.id               AS batch_id,
            b.expires_at       AS batch_expires_at,
            ${SIGNER_COLUMNS},
            z.id               AS zip_id,
            z.object_key,
            z.size::float8     AS size,
            (z.deleted_at IS NOT NULL OR z.status <> 'uploaded') AS zip_deleted
     FROM signing_batches b
     ${SIGNER_JOINS}
     JOIN files z ON z.id = b.source_file_id
     WHERE b.id = $1`,
    [batchId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    batchId: row.batch_id,
    batchExpiresAt: row.batch_expires_at,
    ...toSigner(row),
    zip: { id: row.zip_id, objectKey: row.object_key, size: row.size, deleted: row.zip_deleted },
  };
}

/**
 * แตก ZIP เสร็จ: บันทึกรายการที่ข้าม แล้วเริ่มลงนาม (processing) — เงื่อนไข status = 'extracting' กันบันทึกซ้อน
 * คืน false ถ้าชุดไม่ได้อยู่ในสถานะรอแตกแล้ว (ผู้เรียกต้อง rollback)
 */
export async function markExtractionDone(db: Queryable, input: { batchId: string; skipped: { name: string; reason: string }[] }): Promise<boolean> {
  const result = await db.query(
    `UPDATE signing_batches
     SET status = 'processing', skipped_entries = $2, error_code = NULL, extract_started_at = NULL
     WHERE id = $1
       AND status = 'extracting'`,
    [input.batchId, JSON.stringify(input.skipped)],
  );
  return result.rowCount === 1;
}

/** ทั้งชุดล้มเหลว (ZIP ใช้ไม่ได้ / บัญชีหรือใบใช้ไม่ได้ / ลองครบแล้ว) — เก็บรายการที่ข้ามไว้แสดงด้วยถ้ามี */
export async function markBatchFailed(
  db: Queryable,
  input: { batchId: string; errorCode: string; skipped?: { name: string; reason: string }[] },
): Promise<void> {
  await db.query(
    `UPDATE signing_batches
     SET status = 'failed', error_code = $2, skipped_entries = COALESCE($3, skipped_entries), extract_started_at = NULL
     WHERE id = $1
       AND status IN ('extracting', 'processing')`,
    [input.batchId, input.errorCode, input.skipped ? JSON.stringify(input.skipped) : null],
  );
}

/** แตก ZIP ไม่สำเร็จชั่วคราว (storage ล่ม): ลองใหม่หลัง runAfter */
export async function retryExtractionLater(db: Queryable, input: { batchId: string; errorCode: string; runAfter: Date }): Promise<void> {
  await db.query(
    `UPDATE signing_batches
     SET error_code = $2, extract_run_after = $3, extract_started_at = NULL
     WHERE id = $1
       AND status = 'extracting'`,
    [input.batchId, input.errorCode, input.runAfter],
  );
}

/** ชุดของผู้ใช้พร้อมล็อกแถว (ลองใหม่ — กันกดซ้อนกัน 2 ครั้ง) */
export async function lockSigningBatchOfUser(db: Queryable, batchId: string, userId: string): Promise<SigningBatchRow | null> {
  const result = await db.query<SigningBatchRow>(
    `SELECT ${BATCH_COLUMNS}
     FROM signing_batches b
     WHERE b.id = $1
       AND b.user_id = $2
     FOR UPDATE OF b`,
    [batchId, userId],
  );
  return result.rows[0] ?? null;
}

/** ลองแตก ZIP ใหม่ทั้งชุด (ชุดล้มเหลวด้วยเหตุชั่วคราวระหว่างแตกไฟล์) */
export async function restartExtraction(db: Queryable, batchId: string): Promise<void> {
  await db.query(
    `UPDATE signing_batches
     SET status = 'extracting', error_code = NULL, extract_attempts = 0, extract_run_after = now(), extract_started_at = NULL
     WHERE id = $1`,
    [batchId],
  );
}

/**
 * คืนไฟล์ที่ล้มเหลวด้วยเหตุชั่วคราว (errorCodes) เข้าคิวใหม่ แล้วตั้งชุดเป็น processing — คืนจำนวนไฟล์ที่คืนเข้าคิว
 * ไฟล์ที่ล้มเหลวถาวร (ไฟล์เสีย/มีลายมือชื่อแล้ว) ไม่ถูกแตะ
 */
export async function requeueFailedJobs(db: Queryable, input: { batchId: string; errorCodes: readonly string[] }): Promise<number> {
  const result = await db.query(
    `UPDATE signing_jobs
     SET status = 'pending', error_code = NULL, attempts = 0, run_after = now(), started_at = NULL
     WHERE batch_id = $1
       AND status = 'failed'
       AND error_code = ANY($2::text[])`,
    [input.batchId, input.errorCodes],
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    await db.query(`UPDATE signing_batches SET status = 'processing', error_code = NULL WHERE id = $1`, [input.batchId]);
  }
  return count;
}

/** ไฟล์ที่ลงนามแล้วของชุด (ยังไม่ถูกลบ) สำหรับดาวน์โหลดรวมเป็น ZIP — ชื่อในชุด + object key เรียงตามลำดับในชุด */
export async function listSignedFilesOfBatch(db: Queryable, batchId: string, limit: number): Promise<{ name: string; objectKey: string }[]> {
  const result = await db.query<{ name: string; objectKey: string }>(
    `SELECT j.original_name AS name,
            f.object_key    AS "objectKey"
     FROM signing_jobs j
     JOIN files f ON f.id = j.signed_file_id
     WHERE j.batch_id = $1
       AND j.status = 'signed'
       AND f.deleted_at IS NULL
     ORDER BY j.id
     LIMIT $2`,
    [batchId, limit],
  );
  return result.rows;
}
