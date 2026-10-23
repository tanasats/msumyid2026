import { apiFetch } from './api-server';
import type { Certificate } from './certificate';

/** สถานะการขอใบหลัก (API คำนวณจากนโยบายอายุใบ — ตรวจซ้ำตอนขอเสมอ) */
export type PrimaryRequestStatus = {
  /** วันที่เริ่มขอใบหลักใหม่ได้ — null = ขอได้ตอนนี้ */
  renewableFrom: string | null;
  /** วันหมดอายุโดยประมาณถ้าขอตอนนี้ */
  expiresAtIfRequested: string;
  /** ขอใบใหม่ได้เมื่อใบหลักเดิมเหลือไม่เกินกี่วัน */
  renewalWindowDays: number;
};

/** ใบรับรองของผู้ใช้ปัจจุบัน (ล่าสุดก่อน) พร้อมสถานะการขอใบหลัก */
export async function getMyCertificates(): Promise<{ certificates: Certificate[]; primaryRequest: PrimaryRequestStatus }> {
  return apiFetch('/me/certificates');
}
