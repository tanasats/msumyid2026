import { apiFetch } from './api-server';
import type { SignatureImage, SigningBatchSummary, SigningPinStatus } from './signing';

/** สถานะ PIN ลงนามของผู้ใช้ปัจจุบัน (ต้อง login เท่านั้น) */
export async function getSigningPinStatus(): Promise<SigningPinStatus> {
  return apiFetch('/me/signing-pin');
}

/** ประวัติการลงนามล่าสุด (document:sign) */
export async function getMySigningBatches(): Promise<SigningBatchSummary[]> {
  const { batches } = await apiFetch<{ batches: SigningBatchSummary[] }>('/me/signing-batches');
  return batches;
}

/** ภาพลายเซ็นปัจจุบัน (null = ยังไม่ได้ตั้ง) */
export async function getMySignatureImage(): Promise<SignatureImage | null> {
  const { image } = await apiFetch<{ image: SignatureImage | null }>('/me/signature-image');
  return image;
}
