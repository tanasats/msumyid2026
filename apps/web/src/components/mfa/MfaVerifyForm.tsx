'use client';

import { apiMutate } from '@/lib/api-client';
import { MfaCodeForm } from './MfaCodeForm';

/** ใส่รหัส MFA หลังเข้าสู่ระบบด้วย Google — API ออก session token ใหม่ จึงโหลดหน้าใหม่ทั้งหมด */
export function MfaVerifyForm({ next }: { next: string }) {
  async function verify(code: string) {
    await apiMutate('/auth/mfa/verify', 'POST', { code });
    window.location.assign(next);
  }
  return <MfaCodeForm name="mfa-login" submitLabel="ยืนยัน" onSubmit={verify} />;
}
