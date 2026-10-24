import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import {
  expireFile,
  findFileById,
  insertFile,
  lockExpiredFiles,
  markFileDeleted,
  markFileUploaded,
  type FilePurpose,
  type FileRow,
} from '../repositories/file-repository.js';
import { storage, StorageError } from '../storage/index.js';
import type { AuthUser } from './authorization-service.js';

// ไฟล์ของผู้ใช้ใน storage: ออก presigned URL ให้อัปโหลด → ยืนยันการอัปโหลด → ดาวน์โหลด → ลบเมื่อหมดอายุ
// CLAUDE.md หัวข้อ 11: ตรวจชนิด/ขนาดก่อนออก URL, URL อายุสั้น, object key เป็น UUID, ลบ object ให้ตรงกับฐานข้อมูล

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
/** อายุของ presigned URL (CLAUDE.md: 5–15 นาที) */
const UPLOAD_URL_SECONDS = 10 * 60;
const DOWNLOAD_URL_SECONDS = 5 * 60;
/** ไฟล์ของการลงนามเก็บ 7 วัน (ยืนยัน 2026-10-25) */
export const SIGNING_FILE_RETENTION_DAYS = 7;

/** ชนิดและขนาดที่รับต่อวัตถุประสงค์ (allowlist) — signing_result ระบบสร้างเอง ผู้ใช้อัปโหลดไม่ได้ */
const UPLOAD_RULES: Record<Exclude<FilePurpose, 'signing_result'>, { types: Record<string, number>; retentionDays: number | null }> = {
  signing_source: {
    types: { 'application/pdf': 20 * MB, 'application/zip': 500 * MB },
    retentionDays: SIGNING_FILE_RETENTION_DAYS,
  },
  // ภาพลายเซ็นของผู้ใช้ใช้ซ้ำได้ ไม่หมดอายุ (ลบเมื่อเปลี่ยนภาพหรือลบบัญชี)
  signature_image: { types: { 'image/png': 1 * MB }, retentionDays: null },
};

export type UploadablePurpose = keyof typeof UPLOAD_RULES;

const prefixOf = (purpose: FilePurpose) => purpose.replace('_', '-');

function storageUnavailable(err: unknown): never {
  logger.error({ err }, 'เรียกที่เก็บไฟล์ไม่สำเร็จ');
  throw new AppError(503, 'STORAGE_UNAVAILABLE', 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
}

export type FileInfo = Pick<FileRow, 'id' | 'purpose' | 'originalName' | 'mimeType' | 'size' | 'status' | 'expiresAt' | 'createdAt'>;

const toInfo = ({ id, purpose, originalName, mimeType, size, status, expiresAt, createdAt }: FileRow): FileInfo => ({
  id,
  purpose,
  originalName,
  mimeType,
  size,
  status,
  expiresAt,
  createdAt,
});

/**
 * ขอ URL อัปโหลด — ตรวจชนิด/ขนาดตาม allowlist ก่อนออก URL แล้วบันทึกแถว pending
 * URL เซ็น Content-Type ไว้ browser อัปโหลดชนิดอื่นไม่ได้ ส่วนขนาดตรวจอีกครั้งตอนยืนยัน
 */
export async function createUpload(
  user: AuthUser,
  input: { purpose: UploadablePurpose; originalName: string; mimeType: string; size: number },
): Promise<{ file: FileInfo; uploadUrl: string; uploadExpiresAt: Date }> {
  const rule = UPLOAD_RULES[input.purpose];
  const maxSize = rule.types[input.mimeType];
  if (maxSize === undefined) {
    throw new AppError(422, 'FILE_TYPE_NOT_ALLOWED', `ไม่รับไฟล์ชนิดนี้ (รับ: ${Object.keys(rule.types).join(', ')})`);
  }
  if (input.size <= 0 || input.size > maxSize) {
    throw new AppError(422, 'FILE_TOO_LARGE', `ไฟล์ต้องไม่ว่างและไม่เกิน ${maxSize / MB} MB`);
  }

  const objectKey = `${prefixOf(input.purpose)}/${crypto.randomUUID()}`;
  const file = await insertFile(pool, {
    bucket: config.s3.bucket,
    objectKey,
    purpose: input.purpose,
    originalName: input.originalName,
    mimeType: input.mimeType,
    size: input.size,
    status: 'pending',
    uploadedBy: user.id,
    // ไฟล์ที่อัปโหลดไม่เสร็จก็หมดอายุตามรอบเดียวกัน (job ลบให้)
    expiresAt: new Date(Date.now() + (rule.retentionDays ?? 1) * DAY_MS),
  });
  let uploadUrl: string;
  try {
    uploadUrl = await storage.presignUpload(objectKey, { contentType: input.mimeType, expiresInSeconds: UPLOAD_URL_SECONDS });
  } catch (err) {
    storageUnavailable(err);
  }
  return { file: toInfo(file), uploadUrl, uploadExpiresAt: new Date(Date.now() + UPLOAD_URL_SECONDS * 1000) };
}

async function findOwnFile(user: AuthUser, fileId: string): Promise<FileRow> {
  const file = await findFileById(pool, fileId);
  // ไฟล์ของคนอื่นตอบ "ไม่พบ" เหมือนไฟล์ที่ไม่มี
  if (!file || file.uploadedBy !== user.id) throw new AppError(404, 'FILE_NOT_FOUND', 'ไม่พบไฟล์นี้');
  return file;
}

/**
 * ยืนยันว่าอัปโหลดเสร็จ — ตรวจว่ามี object จริง ขนาดและชนิดตรงกับที่ขอ URL ไว้
 * ไม่ตรง = ลบ object ทิ้ง (ผ่าน job) แล้วแจ้งให้อัปโหลดใหม่
 */
export async function completeUpload(user: AuthUser, fileId: string): Promise<FileInfo> {
  const file = await findOwnFile(user, fileId);
  if (file.status === 'uploaded') return toInfo(file);

  let info;
  try {
    info = await storage.head(file.objectKey);
  } catch (err) {
    storageUnavailable(err);
  }
  if (!info) throw new AppError(409, 'UPLOAD_NOT_FOUND', 'ยังไม่พบไฟล์ที่อัปโหลด กรุณาอัปโหลดใหม่');
  if (info.size !== file.size || (info.contentType && info.contentType !== file.mimeType)) {
    await expireFile(pool, file.id);
    throw new AppError(422, 'UPLOAD_MISMATCH', 'ไฟล์ที่อัปโหลดไม่ตรงกับที่แจ้งไว้ กรุณาอัปโหลดใหม่');
  }
  await markFileUploaded(pool, file.id);
  return toInfo({ ...file, status: 'uploaded' });
}

/** URL ดาวน์โหลดไฟล์ของตัวเอง (อายุ 5 นาที) — ใช้ชื่อไฟล์ต้นฉบับ */
export async function getDownloadUrl(user: AuthUser, fileId: string): Promise<{ url: string; expiresAt: Date }> {
  const file = await findOwnFile(user, fileId);
  if (file.status !== 'uploaded') throw new AppError(409, 'FILE_NOT_READY', 'ไฟล์ยังอัปโหลดไม่เสร็จ');
  try {
    const url = await storage.presignDownload(file.objectKey, { fileName: file.originalName, expiresInSeconds: DOWNLOAD_URL_SECONDS });
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_SECONDS * 1000) };
  } catch (err) {
    storageUnavailable(err);
  }
}

const CLEANUP_BATCH = 100;

/**
 * ลบไฟล์ที่หมดอายุ: ลบ object ใน storage ก่อน แล้วจึงตั้ง deleted_at (ลำดับนี้ทำให้ไม่มี object ค้างโดยไม่มีแถวอ้างถึง)
 * ทำทีละชุดในแต่ละ transaction — storage ล่มกลางทาง = ไฟล์ที่เหลือรอรอบถัดไป คืนจำนวนที่ลบ
 */
export async function cleanupExpiredFiles(): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await withTransaction(async (client) => {
      const files = await lockExpiredFiles(client, CLEANUP_BATCH);
      for (const file of files) {
        await storage.remove(file.objectKey);
        await markFileDeleted(client, file.id);
      }
      return files.length;
    });
    total += removed;
    if (removed < CLEANUP_BATCH) return total;
  }
}

/** เริ่มลบไฟล์หมดอายุตามรอบ (รอบแรกทันที) — คืนฟังก์ชันหยุด สำหรับ graceful shutdown */
export function startFileCleanupJob(intervalMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await cleanupExpiredFiles();
      if (removed > 0) logger.info({ removed }, 'ลบไฟล์ที่หมดอายุแล้ว');
    } catch (err) {
      // storage ล่ม = ลองใหม่รอบถัดไป ไม่ทำให้ API ล้ม
      logger.error({ err: err instanceof StorageError ? err.cause : err }, 'ลบไฟล์ที่หมดอายุไม่สำเร็จ จะลองใหม่รอบถัดไป');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => clearInterval(timer);
}
