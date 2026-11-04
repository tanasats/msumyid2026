import { apiFetch } from './api-server';
import type { MfaStatus } from './mfa';

// เรียก API ของ MFA จาก Server Component

export async function getMyMfaStatus(): Promise<MfaStatus> {
  return apiFetch<MfaStatus>('/me/mfa');
}
