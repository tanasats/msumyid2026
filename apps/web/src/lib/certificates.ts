import { apiFetch } from './api-server';
import type { Certificate } from './certificate';

/** สถานะการขอใบประจำตัว (API คำนวณจากนโยบายอายุใบ — ตรวจซ้ำตอนขอเสมอ) */
export type PrimaryRequestStatus = {
  /** วันที่เริ่มขอใบประจำตัวใหม่ได้ — null = ขอได้ตอนนี้ */
  renewableFrom: string | null;
  /** วันหมดอายุโดยประมาณถ้าขอตอนนี้ */
  expiresAtIfRequested: string;
  /** ขอใบใหม่ได้เมื่อใบประจำตัวเดิมเหลือไม่เกินกี่วัน */
  renewalWindowDays: number;
  /** เพิกถอนใบประจำตัวเองเกินโควตาในรอบ 1 ปีแล้ว — ต้องส่งคำขอแทนการสร้างเอง */
  reissueLimitReached: boolean;
};

/** ใบรับรองของผู้ใช้ปัจจุบัน (ล่าสุดก่อน) พร้อมสถานะการขอใบประจำตัว */
export async function getMyCertificates(): Promise<{ certificates: Certificate[]; primaryRequest: PrimaryRequestStatus }> {
  return apiFetch('/me/certificates');
}
