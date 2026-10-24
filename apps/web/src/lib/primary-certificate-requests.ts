import { apiFetch } from './api-server';
import type { AdminPrimaryRequest, PrimaryRequest } from './primary-certificate-request';

/** คำขอใบประจำตัวของผู้ใช้ปัจจุบัน ล่าสุดก่อน (ต้อง login เท่านั้น) */
export async function getMyPrimaryRequests(): Promise<PrimaryRequest[]> {
  const { requests } = await apiFetch<{ requests: PrimaryRequest[] }>('/me/primary-certificate-requests');
  return requests;
}

export type AdminPrimaryRequestView = 'pending' | 'all' | 'approved' | 'issued' | 'rejected' | 'cancelled' | 'expired';

/** คำขอใบประจำตัวสำหรับผู้อนุมัติ (ต้องมี certificate:approve — API ตรวจ) */
export async function listAdminPrimaryRequests(query: {
  view: AdminPrimaryRequestView;
  cursor?: string;
}): Promise<{ requests: AdminPrimaryRequest[]; nextCursor: string | null; pendingCount: number }> {
  const params = new URLSearchParams({ view: query.view });
  if (query.cursor) params.set('cursor', query.cursor);
  return apiFetch(`/admin/primary-certificate-requests?${params}`);
}
