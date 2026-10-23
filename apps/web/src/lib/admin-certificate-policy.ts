import { apiFetch } from './api-server';
import type { CertificatePolicy, CertificatePolicyLog } from './certificate-policy';

/** นโยบายอายุใบรับรอง + ประวัติการแก้ (ต้องมี certificate_policy:manage — API ตรวจ) */
export async function getCertificatePolicyForAdmin(): Promise<{
  policy: CertificatePolicy;
  logs: CertificatePolicyLog[];
  primaryExpiryPreview: string;
}> {
  return apiFetch('/admin/certificate-policy');
}
