// ชนิดข้อมูลการลงนามเอกสาร — ใช้ได้ทั้ง Server และ Client Component (ไม่ import โมดูลฝั่ง server)
import type { Certificate } from './certificate';

/** PDF ที่ลงนามได้ต่อไฟล์ (ตรงกับ allowlist ของ API: signing_source) */
export const MAX_SIGNING_PDF_BYTES = 20 * 1024 * 1024;

export type SigningPinStatus = { hasPin: boolean; lockedUntil: string | null };

export type SigningJobStatus = 'pending' | 'signing' | 'signed' | 'failed';
export type SigningBatchStatus = 'processing' | 'completed' | 'failed';

export type SigningJob = {
  id: string;
  originalName: string;
  status: SigningJobStatus;
  error: { code: string; message: string } | null;
  /** ดาวน์โหลดผ่าน GET /me/files/:id/download — null เมื่อยังไม่เสร็จหรือเลย 7 วันแล้ว */
  signedFileId: string | null;
  signedAt: string | null;
};

export type SigningBatch = {
  id: string;
  status: SigningBatchStatus;
  source: 'single' | 'zip';
  lockDocument: boolean;
  certificateId: string;
  expiresAt: string;
  createdAt: string;
  jobs: SigningJob[];
};

export type SigningBatchSummary = Omit<SigningBatch, 'jobs'> & {
  firstName: string | null;
  firstSignedFileId: string | null;
  totalJobs: number;
  signedJobs: number;
  failedJobs: number;
};

/** ใบที่ใช้ลงนามบนเว็บได้: ใช้งานได้อยู่และมี key สำรอง (server ลงนามด้วย key สำรอง) — API ตรวจซ้ำเสมอ */
export function canSignWith(c: Pick<Certificate, 'status' | 'hasKeyEscrow' | 'notBefore'>, now = new Date()): boolean {
  return c.status === 'active' && c.hasKeyEscrow && new Date(c.notBefore) <= now;
}

export const BATCH_STATUS_LABELS: Record<SigningBatchStatus, string> = {
  processing: 'กำลังลงนาม',
  completed: 'ลงนามแล้ว',
  failed: 'ไม่สำเร็จ',
};

/** ภาพลายเซ็น PNG ไม่เกิน 1 MB (ตรงกับ allowlist ของ API: signature_image) */
export const MAX_SIGNATURE_IMAGE_BYTES = 1024 * 1024;

/** ภาพลายเซ็นของผู้ใช้ (GET /me/signature-image) — url แสดงภาพได้ 5 นาที */
export type SignatureImage = { fileId: string; width: number; height: number; updatedAt: string; url: string };

/** ตำแหน่งกรอบลายเซ็น: หน้า (เริ่ม 1) และสัดส่วน 0–1 ของหน้าที่แสดงผล จากมุมซ้ายบน — ตรงกับ appearance ของ API */
export type SignatureBox = { page: number; x: number; y: number; w: number; h: number };

/** สัดส่วนความสูงของส่วนข้อความเมื่อมีทั้งภาพและข้อความ (ตรงกับ TEXT_SHARE ของ API) */
export const APPEARANCE_TEXT_SHARE = 0.32;

const previewDateFormatter = new Intl.DateTimeFormat('th-TH', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** ข้อความใต้ภาพสำหรับแสดงตัวอย่าง (API สร้างข้อความจริงจากเวลาที่ลงนาม) */
export function previewAppearanceLines(name: string, at = new Date()): [string, string] {
  const parts = Object.fromEntries(previewDateFormatter.formatToParts(at).map((p) => [p.type, p.value]));
  return [`ลงนามดิจิทัลโดย ${name}`, `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute} น.`];
}
