import { PDFDocument } from 'pdf-lib';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import { clearFileExpiry, expireFile, findFileById } from '../repositories/file-repository.js';
import { deleteSignatureImage, findSignatureImage, upsertSignatureImage } from '../repositories/signature-image-repository.js';
import { storage } from '../storage/index.js';
import type { AuthUser } from './authorization-service.js';

// ภาพลายเซ็น (docs/design/document-signing.md ระยะ D2) — อัปโหลด PNG ผ่าน /me/files แล้วผูกเป็นภาพของผู้ใช้
// เก็บจนผู้ใช้เปลี่ยน/ลบภาพหรือลบบัญชี (ยืนยัน 2026-10-25)

/** ขนาดภาพที่รับ (pixel) — ภาพจากการวาดบนจอหรือสแกนลายมือไม่จำเป็นต้องใหญ่กว่านี้ */
const MIN_SIDE = 16;
const MAX_SIDE = 2000;
const URL_SECONDS = 5 * 60;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ขนาดภาพจาก chunk IHDR (ต้องเป็น chunk แรกเสมอตามมาตรฐาน PNG) — ไม่ใช่ PNG = null */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_MAGIC) || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

export type SignatureImage = { fileId: string; width: number; height: number; updatedAt: Date; url: string };

async function presign(objectKey: string): Promise<string> {
  try {
    return await storage.presignDownload(objectKey, { fileName: 'signature.png', expiresInSeconds: URL_SECONDS });
  } catch (err) {
    logger.error({ err }, 'ออก URL ภาพลายเซ็นไม่สำเร็จ');
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
  }
}

/** ภาพลายเซ็นของผู้ใช้ปัจจุบันพร้อม URL แสดงภาพ (อายุ 5 นาที) — null = ยังไม่ได้ตั้ง */
export async function getMySignatureImage(user: AuthUser): Promise<SignatureImage | null> {
  const image = await findSignatureImage(pool, user.id);
  if (!image) return null;
  return { fileId: image.fileId, width: image.width, height: image.height, updatedAt: image.updatedAt, url: await presign(image.objectKey) };
}

/**
 * ตั้ง/เปลี่ยนภาพลายเซ็นจากไฟล์ที่อัปโหลดแล้ว: อ่านไฟล์จริงจาก storage ตรวจว่าเป็น PNG ขนาดอยู่ในช่วง และ pdf-lib ฝังได้
 * ไม่ผ่าน = ไฟล์นั้นหมดอายุทันที / ผ่าน = แทนภาพเดิม และไฟล์ภาพเดิมหมดอายุทันที (ใน transaction เดียว)
 */
export async function setMySignatureImage(user: AuthUser, fileId: string): Promise<SignatureImage> {
  const file = await findFileById(pool, fileId);
  if (!file || file.uploadedBy !== user.id || file.purpose !== 'signature_image') {
    throw new AppError(404, 'FILE_NOT_FOUND', 'ไม่พบไฟล์นี้');
  }
  if (file.status !== 'uploaded') throw new AppError(409, 'FILE_NOT_READY', 'ไฟล์ยังอัปโหลดไม่เสร็จ');

  let data: Buffer;
  try {
    data = await storage.getBuffer(file.objectKey);
  } catch (err) {
    logger.error({ err }, 'อ่านภาพลายเซ็นจาก storage ไม่สำเร็จ');
    throw new AppError(503, 'STORAGE_UNAVAILABLE', 'ระบบจัดเก็บไฟล์ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
  }
  const size = pngSize(data);
  const reject = async (message: string) => {
    await expireFile(pool, file.id);
    return new AppError(422, 'SIGNATURE_IMAGE_INVALID', message);
  };
  if (!size) throw await reject('ภาพลายเซ็นต้องเป็นไฟล์ PNG');
  if (Math.min(size.width, size.height) < MIN_SIDE || Math.max(size.width, size.height) > MAX_SIDE) {
    throw await reject(`ภาพลายเซ็นต้องกว้างและสูง ${MIN_SIDE}–${MAX_SIDE} pixel`);
  }
  try {
    await (await PDFDocument.create()).embedPng(data);
  } catch {
    throw await reject('อ่านไฟล์ภาพไม่ได้ ไฟล์อาจเสีย กรุณาบันทึกเป็น PNG ใหม่');
  }

  await withTransaction(async (client) => {
    const oldFileId = await upsertSignatureImage(client, { userId: user.id, fileId: file.id, width: size.width, height: size.height });
    // file-service ตั้งให้หมดอายุ 1 วันตอนอัปโหลด (กันไฟล์ค้าง) — ผูกเป็นภาพแล้วจึงเก็บถาวร
    await clearFileExpiry(client, file.id);
    if (oldFileId) await expireFile(client, oldFileId);
  });
  return (await getMySignatureImage(user))!;
}

/** ลบภาพลายเซ็น — ไฟล์หมดอายุทันที (job ลบ object) ไม่มีภาพอยู่แล้วก็สำเร็จ */
export async function deleteMySignatureImage(user: AuthUser): Promise<void> {
  await withTransaction(async (client) => {
    const fileId = await deleteSignatureImage(client, user.id);
    if (fileId) await expireFile(client, fileId);
  });
}
