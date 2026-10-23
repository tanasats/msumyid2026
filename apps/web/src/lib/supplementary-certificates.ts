import { apiFetch } from './api-server';
import type { AdminSupplementaryRequest, SupplementaryLimits, SupplementaryRequest } from './supplementary-certificate';

/** คำขอใบเสริมของผู้ใช้ปัจจุบัน (ล่าสุดก่อน) + เพดานตามนโยบาย (ต้อง login เท่านั้น) */
export async function getMySupplementaryRequests(): Promise<{ requests: SupplementaryRequest[]; limits: SupplementaryLimits }> {
  return apiFetch('/me/supplementary-certificate-requests');
}

/** pending = คิวรออนุมัติ, all = ประวัติที่ตัดสินแล้วทั้งหมด, อื่น ๆ = ประวัติตามสถานะ */
export type AdminRequestView = 'pending' | 'all' | 'approved' | 'issued' | 'rejected' | 'cancelled' | 'expired';

/** คำขอใบเสริมสำหรับผู้อนุมัติ (ต้องมี certificate:approve — API ตรวจ) */
export async function listAdminSupplementaryRequests(query: {
  view: AdminRequestView;
  cursor?: string;
}): Promise<{
  requests: AdminSupplementaryRequest[];
  nextCursor: string | null;
  pendingCount: number;
  /** เพดานช่วงวันที่ ให้กล่องอนุมัติตรวจล่วงหน้า */
  limits: Pick<SupplementaryLimits, 'maxDays' | 'maxLeadDays' | 'today'>;
}> {
  const params = new URLSearchParams({ view: query.view });
  if (query.cursor) params.set('cursor', query.cursor);
  return apiFetch(`/admin/supplementary-certificate-requests?${params}`);
}
