import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { findFileById } from '../repositories/file-repository.js';
import {
  findSigningBatchOfUser,
  findSigningCertificate,
  insertSigningBatch,
  insertSigningJob,
  listSigningBatchesOfUser,
  listSigningJobsOfBatch,
  type SigningBatchRow,
  type SigningBatchStatus,
  type SigningJobRow,
  type SigningJobStatus,
} from '../repositories/signing-repository.js';
import type { AuthUser } from './authorization-service.js';
import { SIGNING_FILE_RETENTION_DAYS } from './file-service.js';
import { verifySigningPin } from './signing-pin-service.js';

// ลงนามเอกสารบนเว็บ (docs/design/document-signing.md) ฝั่ง API: ตรวจไฟล์ ใบรับรอง และ PIN แล้วสร้างชุด + งานเข้าคิว
// การลงนามจริงทำโดย worker (signing-worker-service) — API ไม่ถือ PIN ต่อหลังตรวจแล้ว

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 20;
/** ชุดหนึ่งมีไม่เกิน 100 ไฟล์ (ZIP ระยะ D3) */
const JOBS_PER_BATCH_LIMIT = 100;

/** ข้อความภาษาไทยของรหัสความล้มเหลวที่ worker บันทึกใน signing_jobs.error_code */
const JOB_ERROR_MESSAGES: Record<string, string> = {
  NOT_PDF: 'ไฟล์นี้ไม่ใช่ PDF',
  ENCRYPTED: 'ไฟล์นี้ตั้งรหัสผ่านหรือจำกัดสิทธิ์ไว้ กรุณาปลดล็อกก่อนลงนาม',
  ALREADY_SIGNED: 'ไฟล์นี้มีลายมือชื่อดิจิทัลอยู่แล้ว ยังลงนามซ้ำไม่ได้',
  INVALID_PDF: 'เปิดไฟล์ PDF ไม่ได้ ไฟล์อาจเสีย',
  SIGNATURE_TOO_LARGE: 'ลายมือชื่อมีขนาดเกินที่จองไว้ในไฟล์ กรุณาติดต่อผู้ดูแลระบบ',
  TSA_UNAVAILABLE: 'บริการประทับเวลาของมหาวิทยาลัยไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
  SIGNER_UNAVAILABLE: 'ระบบลงนามไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
  STORAGE_UNAVAILABLE: 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
  CERTIFICATE_NOT_USABLE: 'ใบรับรองที่เลือกใช้ลงนามไม่ได้แล้ว (หมดอายุ ถูกเพิกถอน หรือไม่มี key สำรอง)',
  ACCOUNT_NOT_ALLOWED: 'บัญชีของคุณไม่มีสิทธิ์ลงนามเอกสารแล้ว',
  SOURCE_MISSING: 'ไม่พบไฟล์ต้นฉบับ (อาจหมดอายุแล้ว) กรุณาอัปโหลดใหม่',
  VERIFY_FAILED: 'ตรวจลายมือชื่อหลังลงนามไม่ผ่าน ระบบจึงไม่ออกไฟล์ กรุณาติดต่อผู้ดูแลระบบ',
  TIMEOUT: 'ลงนามไม่เสร็จในเวลาที่กำหนด กรุณาลองใหม่',
  INTERNAL: 'ลงนามไม่สำเร็จ กรุณาลองใหม่ภายหลัง',
};

export function signingErrorMessage(code: string): string {
  return JOB_ERROR_MESSAGES[code] ?? JOB_ERROR_MESSAGES.INTERNAL!;
}

export type SigningJob = {
  id: string;
  originalName: string;
  /** pending/signing แสดงเป็น "กำลังลงนาม" เหมือนกัน */
  status: SigningJobStatus;
  /** มีค่าเมื่อ status = failed */
  error: { code: string; message: string } | null;
  /** ดาวน์โหลดผ่าน GET /me/files/:id/download */
  signedFileId: string | null;
  signedAt: Date | null;
};

export type SigningBatch = {
  id: string;
  status: SigningBatchStatus;
  source: 'single' | 'zip';
  lockDocument: boolean;
  certificateId: string;
  expiresAt: Date;
  createdAt: Date;
  jobs: SigningJob[];
};

/** filesAvailable = false เมื่อชุดเลย 7 วันแล้ว (ไฟล์ถูกลบ เหลือแค่ประวัติ) */
const toJob = (job: SigningJobRow, filesAvailable: boolean): SigningJob => ({
  id: job.id,
  originalName: job.originalName,
  status: job.status,
  error: job.status === 'failed' && job.errorCode ? { code: job.errorCode, message: signingErrorMessage(job.errorCode) } : null,
  signedFileId: job.status === 'signed' && filesAvailable ? job.signedFileId : null,
  signedAt: job.signedAt,
});

const toBatch = (batch: SigningBatchRow, jobs: SigningJobRow[]): SigningBatch => {
  const filesAvailable = batch.expiresAt > new Date();
  return {
    id: batch.id,
    status: batch.status,
    source: batch.source,
    lockDocument: batch.lockDocument,
    certificateId: batch.certificateId,
    expiresAt: batch.expiresAt,
    createdAt: batch.createdAt,
    jobs: jobs.map((job) => toJob(job, filesAvailable)),
  };
};

/**
 * ตรวจใบที่จะใช้ลงนาม: ของผู้ใช้เอง ยังไม่เพิกถอน อยู่ในช่วงอายุ และมี key สำรอง (server ลงนามด้วย key สำรอง)
 * ใบของคนอื่นตอบ "ไม่พบ" เหมือนใบที่ไม่มีอยู่
 */
async function assertUsableCertificate(user: AuthUser, certificateId: string): Promise<void> {
  const certificate = await findSigningCertificate(pool, certificateId);
  if (!certificate || certificate.userId !== user.id) {
    throw new AppError(404, 'CERTIFICATE_NOT_FOUND', 'ไม่พบใบรับรองนี้');
  }
  const now = new Date();
  if (certificate.revokedAt) {
    throw new AppError(409, 'CERTIFICATE_NOT_USABLE', 'ใบรับรองนี้ถูกเพิกถอนแล้ว ใช้ลงนามไม่ได้');
  }
  if (certificate.notAfter <= now || certificate.notBefore > now) {
    throw new AppError(409, 'CERTIFICATE_NOT_USABLE', 'ใบรับรองนี้ไม่อยู่ในช่วงเวลาที่ใช้งานได้ ใช้ลงนามไม่ได้');
  }
  if (!certificate.hasKeyEscrow) {
    throw new AppError(
      409,
      'CERTIFICATE_NOT_USABLE',
      'ใบรับรองนี้ไม่มี key สำรองในระบบ จึงใช้ลงนามบนเว็บไม่ได้ (ใบที่นำเข้าจากระบบเดิมโดยไม่มี key) กรุณาขอใบรับรองใหม่',
    );
  }
}

/**
 * ส่งไฟล์ PDF ที่อัปโหลดแล้ว 1 ไฟล์เข้าคิวลงนาม (มองไม่เห็น) — ตรวจไฟล์และใบก่อน แล้วจึงตรวจ PIN
 * (พิมพ์ผิดที่ส่วนอื่นจึงไม่ทำให้เสียจำนวนครั้งของ PIN) ผ่านทั้งหมดแล้วสร้างชุด + งานใน transaction เดียว
 * worker ตรวจสถานะบัญชีและใบซ้ำอีกครั้งตอนลงนาม
 */
export async function createSigningBatch(
  user: AuthUser,
  input: { fileId: string; certificateId: string; lockDocument: boolean; pin: string },
): Promise<SigningBatch> {
  const file = await findFileById(pool, input.fileId);
  if (!file || file.uploadedBy !== user.id || file.purpose !== 'signing_source') {
    throw new AppError(404, 'FILE_NOT_FOUND', 'ไม่พบไฟล์นี้');
  }
  if (file.status !== 'uploaded') throw new AppError(409, 'FILE_NOT_READY', 'ไฟล์ยังอัปโหลดไม่เสร็จ');
  if (file.expiresAt && file.expiresAt <= new Date()) {
    throw new AppError(404, 'FILE_NOT_FOUND', 'ไฟล์นี้หมดอายุแล้ว กรุณาอัปโหลดใหม่');
  }
  // ZIP หลายไฟล์ยังไม่รองรับ (ระยะ D3)
  if (file.mimeType !== 'application/pdf') {
    throw new AppError(422, 'FILE_TYPE_NOT_ALLOWED', 'ตอนนี้ลงนามได้เฉพาะไฟล์ PDF ทีละไฟล์');
  }
  await assertUsableCertificate(user, input.certificateId);
  await verifySigningPin(user.id, input.pin);

  const batchId = await withTransaction(async (client) => {
    const batch = await insertSigningBatch(client, {
      userId: user.id,
      certificateId: input.certificateId,
      source: 'single',
      lockDocument: input.lockDocument,
      expiresAt: new Date(Date.now() + SIGNING_FILE_RETENTION_DAYS * DAY_MS),
    });
    await insertSigningJob(client, { batchId: batch.id, sourceFileId: file.id, originalName: file.originalName });
    return batch.id;
  });
  return getMySigningBatch(user, batchId);
}

/** ชุดของผู้ใช้พร้อมสถานะทุกไฟล์ (หน้าเว็บถามซ้ำจนกว่าจะจบ) — ชุดของคนอื่นตอบ "ไม่พบ" */
export async function getMySigningBatch(user: AuthUser, batchId: string): Promise<SigningBatch> {
  const batch = await findSigningBatchOfUser(pool, batchId, user.id);
  if (!batch) throw new AppError(404, 'SIGNING_BATCH_NOT_FOUND', 'ไม่พบรายการลงนามนี้');
  return toBatch(batch, await listSigningJobsOfBatch(pool, batch.id, JOBS_PER_BATCH_LIMIT));
}

export type SigningBatchSummary = Omit<SigningBatch, 'jobs'> & {
  firstName: string | null;
  /** null เมื่อยังไม่มีไฟล์ที่ลงนามแล้ว หรือไฟล์ของชุดหมดอายุแล้ว */
  firstSignedFileId: string | null;
  totalJobs: number;
  signedJobs: number;
  failedJobs: number;
};

/** ประวัติการลงนามล่าสุดของผู้ใช้ (ไฟล์ดาวน์โหลดได้ภายใน 7 วัน) */
export async function listMySigningBatches(user: AuthUser): Promise<SigningBatchSummary[]> {
  const rows = await listSigningBatchesOfUser(pool, user.id, LIST_LIMIT);
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    source: row.source,
    lockDocument: row.lockDocument,
    certificateId: row.certificateId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    firstName: row.firstName,
    firstSignedFileId: row.expiresAt > now ? row.firstSignedFileId : null,
    totalJobs: row.totalJobs,
    signedJobs: row.signedJobs,
    failedJobs: row.failedJobs,
  }));
}
