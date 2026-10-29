import { apiFetch } from './api-server';
import type { AdminRevocationRequest, RevocationRequest, RevocationRequestStatus } from './certificate-revocation-request';

/** คำขอเพิกถอนของผู้ใช้ปัจจุบัน ล่าสุดก่อน + เพิกถอนใบประจำตัวเองได้ทันทีหรือไม่ (ต้อง login เท่านั้น) */
export async function getMyRevocationRequests(): Promise<{ requests: RevocationRequest[]; canRevokeDirectly: boolean }> {
  return apiFetch('/me/certificate-revocation-requests');
}

export type AdminRevocationRequestView = 'pending' | 'all' | Exclude<RevocationRequestStatus, 'pending'>;

/** คำขอเพิกถอนสำหรับผู้อนุมัติ (ต้องมี certificate:revoke — API ตรวจ) */
export async function listAdminRevocationRequests(query: {
  view: AdminRevocationRequestView;
  cursor?: string;
}): Promise<{ requests: AdminRevocationRequest[]; nextCursor: string | null; pendingCount: number }> {
  const params = new URLSearchParams({ view: query.view });
  if (query.cursor) params.set('cursor', query.cursor);
  return apiFetch(`/admin/certificate-revocation-requests?${params}`);
}
