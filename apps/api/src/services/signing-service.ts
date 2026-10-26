import type { Readable } from 'node:stream';
import yazl from 'yazl';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import { findFileById } from '../repositories/file-repository.js';
import { findSignatureImage } from '../repositories/signature-image-repository.js';
import {
  findSigningBatchOfUser,
  findSigningCertificate,
  insertSigningBatch,
  insertSigningJob,
  listSignedFilesOfBatch,
  listSigningBatchesOfUser,
  listSigningJobsOfBatch,
  lockSigningBatchOfUser,
  requeueFailedJobs,
  restartExtraction,
  type SigningAppearance,
  type SigningBatchRow,
  type SigningBatchStatus,
  type SigningJobRow,
  type SigningJobStatus,
} from '../repositories/signing-repository.js';
import { storage } from '../storage/index.js';
import type { AuthUser } from './authorization-service.js';
import { SIGNING_FILE_RETENTION_DAYS } from './file-service.js';
import { verifySigningPin } from './signing-pin-service.js';

// ลงนามเอกสารบนเว็บ (docs/design/document-signing.md) ฝั่ง API: ตรวจไฟล์ ใบรับรอง และ PIN แล้วสร้างชุด + งานเข้าคิว
// การลงนามจริง (และการแตก ZIP) ทำโดย worker (signing-worker-service) — API ไม่ถือ PIN ต่อหลังตรวจแล้ว

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 20;
/** ชุดหนึ่งมีไม่เกิน 100 ไฟล์ (ZIP ระยะ D3) */
const JOBS_PER_BATCH_LIMIT = 100;

/** ข้อความภาษาไทยของรหัสความล้มเหลวที่ worker บันทึกใน signing_jobs.error_code / signing_batches.error_code */
const ERROR_MESSAGES: Record<string, string> = {
  NOT_PDF: 'ไฟล์นี้ไม่ใช่ PDF',
  ENCRYPTED: 'ไฟล์นี้ตั้งรหัสผ่านหรือจำกัดสิทธิ์ไว้ กรุณาปลดล็อกก่อนลงนาม',
  // ก่อนระยะ D4a ไฟล์ที่มีลายมือชื่อแล้วลงนามไม่ได้ — คงข้อความไว้ให้งานเก่าที่บันทึกรหัสนี้
  ALREADY_SIGNED: 'ไฟล์นี้มีลายมือชื่อดิจิทัลอยู่แล้ว ยังลงนามซ้ำไม่ได้',
  DOCUMENT_LOCKED: 'เอกสารนี้ถูกล็อกโดยผู้ลงนามคนก่อน (ห้ามแก้ไขใด ๆ) จึงลงนามเพิ่มไม่ได้',
  LOCK_NOT_FIRST: 'ไฟล์นี้มีลายมือชื่ออยู่แล้ว จึงล็อกเอกสารไม่ได้ (ล็อกได้เฉพาะผู้ลงนามคนแรก) — ลงนามใหม่โดยไม่เลือกล็อก',
  TOO_MANY_SIGNATURES: 'ไฟล์นี้มีลายมือชื่อครบจำนวนที่ระบบรองรับแล้ว ลงนามเพิ่มไม่ได้',
  COSIGN_UNSAFE_STRUCTURE: 'ลงนามเพิ่มในไฟล์นี้ไม่ได้: โครงสร้างไฟล์จากโปรแกรมที่ลงนามครั้งแรกทำให้ Acrobat จะแสดงลายมือชื่อเดิมว่าไม่ถูกต้องหลังลงนามเพิ่ม — กรุณาใช้ไฟล์ต้นฉบับที่ยังไม่ลงนาม แล้วให้ทุกคนลงนามตามลำดับในระบบนี้',
  INVALID_PDF: 'เปิดไฟล์ PDF ไม่ได้ ไฟล์อาจเสีย',
  SIGNATURE_TOO_LARGE: 'ลายมือชื่อมีขนาดเกินที่จองไว้ในไฟล์ กรุณาติดต่อผู้ดูแลระบบ',
  PAGE_NOT_FOUND: 'ไฟล์นี้ไม่มีหน้าที่เลือกวางลายเซ็น',
  SIGNATURE_IMAGE_MISSING: 'ไม่พบภาพลายเซ็นที่เลือกไว้ (อาจถูกเปลี่ยนหรือลบแล้ว) กรุณาลงนามใหม่',
  TSA_UNAVAILABLE: 'บริการประทับเวลาของมหาวิทยาลัยไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
  SIGNER_UNAVAILABLE: 'ระบบลงนามไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
  STORAGE_UNAVAILABLE: 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง',
  CERTIFICATE_NOT_USABLE: 'ใบรับรองที่เลือกใช้ลงนามไม่ได้แล้ว (หมดอายุ ถูกเพิกถอน หรือไม่มี key สำรอง)',
  ACCOUNT_NOT_ALLOWED: 'บัญชีของคุณไม่มีสิทธิ์ลงนามเอกสารแล้ว',
  SOURCE_MISSING: 'ไม่พบไฟล์ต้นฉบับ (อาจหมดอายุแล้ว) กรุณาอัปโหลดใหม่',
  VERIFY_FAILED: 'ตรวจลายมือชื่อหลังลงนามไม่ผ่าน ระบบจึงไม่ออกไฟล์ กรุณาติดต่อผู้ดูแลระบบ',
  TIMEOUT: 'ลงนามไม่เสร็จในเวลาที่กำหนด กรุณาลองใหม่',
  INTERNAL: 'ลงนามไม่สำเร็จ กรุณาลองใหม่ภายหลัง',
  // ทั้งชุด ZIP (ระยะ D3)
  ZIP_INVALID: 'เปิดไฟล์ ZIP ไม่ได้ ไฟล์อาจเสียหรือไม่ใช่ ZIP',
  ZIP_TOO_MANY_FILES: 'ZIP มี PDF เกิน 100 ไฟล์ กรุณาแบ่งเป็นหลายชุด',
  ZIP_TOO_LARGE: 'PDF ใน ZIP รวมกันใหญ่เกิน 500 MB กรุณาแบ่งเป็นหลายชุด',
  ZIP_BOMB: 'ZIP นี้มีลักษณะผิดปกติ (บีบอัดมากผิดปกติ) ระบบจึงไม่แตกไฟล์',
  ZIP_NO_PDF: 'ไม่พบไฟล์ PDF ที่ลงนามได้ใน ZIP',
};

/** เหตุที่ข้ามรายการใน ZIP (ดู signing-zip.ts) */
const SKIP_MESSAGES: Record<string, string> = {
  NOT_PDF: 'ไม่ใช่ PDF',
  NESTED_ARCHIVE: 'เป็นไฟล์บีบอัดซ้อนใน ZIP',
  UNSAFE_PATH: 'ชื่อหรือตำแหน่งไฟล์ไม่ปลอดภัย',
  ENCRYPTED_ENTRY: 'ไฟล์ใน ZIP ตั้งรหัสผ่านไว้',
  UNSUPPORTED_COMPRESSION: 'บีบอัดด้วยวิธีที่ระบบไม่รองรับ',
  FILE_TOO_LARGE: 'ใหญ่เกิน 20 MB',
  NAME_TOO_LONG: 'ชื่อไฟล์ยาวเกินไป',
  DUPLICATE_NAME: 'ชื่อซ้ำกับไฟล์อื่นใน ZIP',
};

/** ล้มเหลวเพราะระบบขัดข้องชั่วคราว — ผู้ใช้กดลองใหม่ได้ (ใส่ PIN อีกครั้ง) ส่วนเหตุอื่นลองใหม่ก็ไม่ผ่าน (ยืนยัน 2026-10-25) */
export const RETRYABLE_ERRORS = ['TSA_UNAVAILABLE', 'SIGNER_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'TIMEOUT', 'INTERNAL'] as const;
const isRetryable = (code: string | null) => code !== null && (RETRYABLE_ERRORS as readonly string[]).includes(code);

export function signingErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL!;
}

export type SigningJob = {
  id: string;
  /** ชุด ZIP = path ในไฟล์ ZIP */
  originalName: string;
  /** pending/signing แสดงเป็น "กำลังลงนาม" เหมือนกัน */
  status: SigningJobStatus;
  /** มีค่าเมื่อ status = failed — retryable = ลองใหม่ได้ */
  error: { code: string; message: string; retryable: boolean } | null;
  /** ดาวน์โหลดผ่าน GET /me/files/:id/download */
  signedFileId: string | null;
  signedAt: Date | null;
};

export type SigningBatch = {
  id: string;
  status: SigningBatchStatus;
  source: 'single' | 'zip';
  /** ชื่อไฟล์ ZIP (null = ชุดไฟล์เดียว) */
  zipName: string | null;
  lockDocument: boolean;
  certificateId: string;
  /** เหตุที่ทั้งชุดล้มเหลว (เช่น ZIP เสีย) */
  error: { code: string; message: string; retryable: boolean } | null;
  /** รายการใน ZIP ที่ข้าม */
  skipped: { name: string; reason: string; message: string }[];
  /** มีไฟล์ (หรือการแตก ZIP) ที่ล้มเหลวด้วยเหตุชั่วคราว และชุดจบแล้ว — แสดงปุ่ม "ลองใหม่" */
  canRetry: boolean;
  expiresAt: Date;
  createdAt: Date;
  jobs: SigningJob[];
};

const toError = (code: string | null) => (code ? { code, message: signingErrorMessage(code), retryable: isRetryable(code) } : null);

/** filesAvailable = false เมื่อชุดเลย 7 วันแล้ว (ไฟล์ถูกลบ เหลือแค่ประวัติ) */
const toJob = (job: SigningJobRow, filesAvailable: boolean): SigningJob => ({
  id: job.id,
  originalName: job.originalName,
  status: job.status,
  error: job.status === 'failed' ? toError(job.errorCode) : null,
  signedFileId: job.status === 'signed' && filesAvailable ? job.signedFileId : null,
  signedAt: job.signedAt,
});

const toBatch = (batch: SigningBatchRow, jobs: SigningJobRow[]): SigningBatch => {
  const filesAvailable = batch.expiresAt > new Date();
  const finished = batch.status === 'completed' || batch.status === 'failed';
  const retryableJob = jobs.some((j) => j.status === 'failed' && isRetryable(j.errorCode));
  return {
    id: batch.id,
    status: batch.status,
    source: batch.source,
    zipName: batch.zipName,
    lockDocument: batch.lockDocument,
    certificateId: batch.certificateId,
    error: batch.status === 'failed' ? toError(batch.errorCode) : null,
    skipped: batch.skippedEntries.map((s) => ({ ...s, message: SKIP_MESSAGES[s.reason] ?? s.reason })),
    canRetry: finished && filesAvailable && (retryableJob || (batch.status === 'failed' && isRetryable(batch.errorCode))),
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

/** ตำแหน่งที่หน้าเว็บส่งมา (สัดส่วนของหน้าที่แสดงผล) — route ตรวจช่วงค่าแล้ว */
export type AppearanceInput =
  | { visible: false }
  | { visible: true; page: number; x: number; y: number; w: number; h: number; showText: boolean; useImage: boolean };

/**
 * แปลงตำแหน่งเป็นค่าที่เก็บในชุด: ใช้ภาพ = บันทึก file_id ของภาพลายเซ็นปัจจุบันไว้ (เปลี่ยนภาพภายหลังไม่กระทบชุดที่ส่งแล้ว)
 * ยังไม่ได้ตั้งภาพ = 409 / ไม่มีทั้งภาพและข้อความ = 422
 */
async function resolveAppearance(user: AuthUser, input: AppearanceInput): Promise<SigningAppearance> {
  if (!input.visible) return { visible: false };
  if (!input.useImage && !input.showText) {
    throw new AppError(422, 'APPEARANCE_EMPTY', 'ลายเซ็นแบบมองเห็นต้องมีภาพลายเซ็นหรือข้อความอย่างน้อยหนึ่งอย่าง');
  }
  let imageFileId: string | null = null;
  if (input.useImage) {
    const image = await findSignatureImage(pool, user.id);
    if (!image) throw new AppError(409, 'SIGNATURE_IMAGE_NOT_SET', 'ยังไม่ได้ตั้งภาพลายเซ็น');
    imageFileId = image.fileId;
  }
  const { page, x, y, w, h, showText } = input;
  return { visible: true, page, x, y, w, h, showText, imageFileId };
}

/**
 * ส่งไฟล์ที่อัปโหลดแล้วเข้าคิวลงนาม — PDF 1 ไฟล์ = งานเดียวทันที / ZIP = ชุดรอแตกไฟล์ (worker สร้างงานต่อ PDF, ระยะ D3)
 * ตรวจไฟล์ ใบ และตำแหน่งก่อน แล้วจึงตรวจ PIN (พิมพ์ผิดที่ส่วนอื่นจึงไม่ทำให้เสียจำนวนครั้งของ PIN)
 * worker ตรวจสถานะบัญชีและใบซ้ำอีกครั้งตอนแตกไฟล์และตอนลงนาม (หน้าที่เลือกไม่มีในไฟล์ = PAGE_NOT_FOUND ของไฟล์นั้น)
 */
export async function createSigningBatch(
  user: AuthUser,
  input: { fileId: string; certificateId: string; lockDocument: boolean; appearance: AppearanceInput; pin: string },
): Promise<SigningBatch> {
  const file = await findFileById(pool, input.fileId);
  if (!file || file.uploadedBy !== user.id || file.purpose !== 'signing_source') {
    throw new AppError(404, 'FILE_NOT_FOUND', 'ไม่พบไฟล์นี้');
  }
  if (file.status !== 'uploaded') throw new AppError(409, 'FILE_NOT_READY', 'ไฟล์ยังอัปโหลดไม่เสร็จ');
  if (file.expiresAt && file.expiresAt <= new Date()) {
    throw new AppError(404, 'FILE_NOT_FOUND', 'ไฟล์นี้หมดอายุแล้ว กรุณาอัปโหลดใหม่');
  }
  const zip = file.mimeType === 'application/zip';
  if (!zip && file.mimeType !== 'application/pdf') {
    throw new AppError(422, 'FILE_TYPE_NOT_ALLOWED', 'ลงนามได้เฉพาะไฟล์ PDF หรือ ZIP ที่รวม PDF ไว้');
  }
  await assertUsableCertificate(user, input.certificateId);
  const appearance = await resolveAppearance(user, input.appearance);
  await verifySigningPin(user.id, input.pin);

  const base = {
    userId: user.id,
    certificateId: input.certificateId,
    lockDocument: input.lockDocument,
    appearance,
    expiresAt: new Date(Date.now() + SIGNING_FILE_RETENTION_DAYS * DAY_MS),
  };
  const batchId = zip
    ? (await insertSigningBatch(pool, { ...base, source: 'zip', zipFileId: file.id })).id
    : await withTransaction(async (client) => {
        const batch = await insertSigningBatch(client, { ...base, source: 'single' });
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

/**
 * ลองใหม่เฉพาะส่วนที่ล้มเหลวด้วยเหตุชั่วคราว (ยืนยัน 2026-10-25): ต้องใส่ PIN อีกครั้ง และใบยังต้องใช้ได้
 * - การแตก ZIP ล้มเหลวชั่วคราว = แตกใหม่ทั้งชุด
 * - ไฟล์ที่ล้มเหลวชั่วคราว = คืนเข้าคิว (ไฟล์เสีย/มีลายมือชื่อแล้วไม่แตะ)
 * ล็อกแถวชุดไว้ตลอด กันกดลองใหม่ซ้อนกัน
 */
export async function retryMySigningBatch(user: AuthUser, batchId: string, pin: string): Promise<SigningBatch> {
  const batch = await findSigningBatchOfUser(pool, batchId, user.id);
  if (!batch) throw new AppError(404, 'SIGNING_BATCH_NOT_FOUND', 'ไม่พบรายการลงนามนี้');
  if (!toBatch(batch, await listSigningJobsOfBatch(pool, batch.id, JOBS_PER_BATCH_LIMIT)).canRetry) {
    throw new AppError(409, 'NOTHING_TO_RETRY', 'ไม่มีไฟล์ที่ลองใหม่ได้ (กำลังลงนามอยู่ หมดอายุแล้ว หรือไฟล์ที่ล้มเหลวลองใหม่ก็ไม่ผ่าน)');
  }
  await assertUsableCertificate(user, batch.certificateId);
  await verifySigningPin(user.id, pin);

  await withTransaction(async (client) => {
    const locked = await lockSigningBatchOfUser(client, batchId, user.id);
    if (!locked || (locked.status !== 'completed' && locked.status !== 'failed')) {
      throw new AppError(409, 'NOTHING_TO_RETRY', 'รายการนี้กำลังลงนามอยู่แล้ว');
    }
    if (locked.status === 'failed' && locked.source === 'zip' && isRetryable(locked.errorCode)) {
      await restartExtraction(client, batchId);
      return;
    }
    const requeued = await requeueFailedJobs(client, { batchId, errorCodes: RETRYABLE_ERRORS });
    if (requeued === 0) throw new AppError(409, 'NOTHING_TO_RETRY', 'ไม่มีไฟล์ที่ลองใหม่ได้');
  });
  return getMySigningBatch(user, batchId);
}

/**
 * ดาวน์โหลดไฟล์ที่ลงนามแล้วทั้งชุดเป็น ZIP — สร้างส่งตรงขณะดาวน์โหลด ไม่เก็บซ้ำใน storage (ยืนยัน 2026-10-25)
 * ชื่อในไฟล์ ZIP = path เดิมใน ZIP ต้นฉบับ (คงโครงสร้างโฟลเดอร์) ไม่บีบอัดซ้ำ (PDF บีบอัดได้น้อย ประหยัด CPU)
 * อ่าน object ทีละไฟล์ตามลำดับ (addReadStreamLazy) ไม่เปิดพร้อมกันทั้งชุด — storage ล่มกลางทาง = ตัดการเชื่อมต่อ
 */
export async function downloadMySignedBatch(user: AuthUser, batchId: string): Promise<{ fileName: string; stream: Readable }> {
  const batch = await findSigningBatchOfUser(pool, batchId, user.id);
  if (!batch) throw new AppError(404, 'SIGNING_BATCH_NOT_FOUND', 'ไม่พบรายการลงนามนี้');
  if (batch.expiresAt <= new Date()) throw new AppError(410, 'SIGNING_FILES_EXPIRED', 'ไฟล์ของรายการนี้ถูกลบแล้ว (เก็บไว้ 7 วัน)');
  const files = await listSignedFilesOfBatch(pool, batch.id, JOBS_PER_BATCH_LIMIT);
  if (files.length === 0) throw new AppError(409, 'NO_SIGNED_FILES', 'ยังไม่มีไฟล์ที่ลงนามแล้วในรายการนี้');

  const zip = new yazl.ZipFile();
  for (const file of files) {
    zip.addReadStreamLazy(file.name, { compress: false }, (cb) => {
      storage.getStream(file.objectKey).then(
        (stream) => cb(null, stream),
        (err: unknown) => {
          logger.error({ err, signingBatchId: batchId }, 'อ่านไฟล์ที่ลงนามแล้วระหว่างสร้าง ZIP ไม่สำเร็จ');
          cb(err, null as unknown as Readable);
        },
      );
    });
  }
  zip.end();
  // yazl แจ้ง error ที่ ZipFile ไม่ใช่ outputStream — ส่งต่อให้ stream ไม่เช่นนั้นการดาวน์โหลดค้างไม่จบ
  const output = zip.outputStream as Readable;
  zip.on('error', (err: Error) => output.destroy(err));
  const base = (batch.zipName ?? files[0]!.name.split('/').at(-1)!).replace(/\.(zip|pdf)$/i, '').slice(0, 200) || 'documents';
  return { fileName: `${base}-signed.zip`, stream: output };
}

export type SigningBatchSummary = {
  id: string;
  status: SigningBatchStatus;
  source: 'single' | 'zip';
  lockDocument: boolean;
  certificateId: string;
  expiresAt: Date;
  createdAt: Date;
  /** ชื่อที่แสดงในประวัติ: ชื่อ ZIP หรือชื่อไฟล์เดียว */
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
    firstName: row.zipName ?? row.firstName,
    firstSignedFileId: row.expiresAt > now ? row.firstSignedFileId : null,
    totalJobs: row.totalJobs,
    signedJobs: row.signedJobs,
    failedJobs: row.failedJobs,
  }));
}
