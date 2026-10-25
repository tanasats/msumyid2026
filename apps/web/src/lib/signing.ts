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
