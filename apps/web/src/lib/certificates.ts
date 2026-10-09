import { apiFetch } from './api-server';
import type { Certificate } from './certificate';

/** ใบรับรองของผู้ใช้ปัจจุบัน (ล่าสุดก่อน) พร้อมจำนวนใบที่ใช้งานพร้อมกันได้สูงสุด */
export async function getMyCertificates(): Promise<{ certificates: Certificate[]; maxActive: number }> {
  return apiFetch<{ certificates: Certificate[]; maxActive: number }>('/me/certificates');
}
