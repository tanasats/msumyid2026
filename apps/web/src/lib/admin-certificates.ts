import { apiFetch } from './api-server';
import type { Certificate, CertificateStatus } from './certificate';

/** ใบรับรองในหน้าผู้ดูแล — owner = null คือใบที่นำเข้าแล้วยังไม่มีเจ้าของ */
export type AdminCertificate = Certificate & { owner: { id: string; displayName: string } | null };

export type AdminCertificateQuery = {
  q?: string;
  status?: CertificateStatus;
  cursor?: string;
};

/** ค้นหาใบรับรองทั้งระบบ (ต้องมี certificate:read — API ตรวจ) */
export async function searchAdminCertificates(
  query: AdminCertificateQuery,
): Promise<{ certificates: AdminCertificate[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  return apiFetch(`/admin/certificates?${params}`);
}

/** ใบรับรองของผู้ใช้คนหนึ่ง (ต้องมี certificate:read) */
export async function getUserCertificates(userId: string): Promise<Certificate[]> {
  const { certificates } = await apiFetch<{ certificates: Certificate[] }>(
    `/admin/users/${encodeURIComponent(userId)}/certificates`,
  );
  return certificates;
}
