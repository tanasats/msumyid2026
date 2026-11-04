import { cache } from 'react';
import { redirect } from 'next/navigation';
import type { AccountType } from './account-type';
import { ApiError, apiFetch } from './api-server';

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  /** รับทราบประกาศความเป็นส่วนตัวฉบับปัจจุบันแล้ว (docs/design/pdpa.md) */
  privacyAcknowledged: boolean;
  roles: string[];
  /** ใช้ซ่อน/แสดงเมนูเท่านั้น การตรวจสิทธิ์จริงอยู่ที่ API */
  permissions: string[];
  /** งานที่ไม่ได้คุมด้วย permission (เช่น super_admin เท่านั้น) — API คำนวณ web ไม่ต้องเช็คชื่อ role เอง */
  capabilities: { manageRoles: boolean; manageSettings: boolean };
  /**
   * การยืนยันตัวตนสองขั้นตอน (docs/design/mfa.md): enabled = เปิดแล้ว, required = บทบาทบังคับ,
   * verified = session นี้ใส่รหัสแล้ว (ยังไม่ใส่ = roles/permissions ว่าง)
   */
  mfa: { enabled: boolean; required: boolean; verified: boolean };
};

/** เปิด MFA แล้วแต่ session นี้ยังไม่ใส่รหัส */
export function isMfaPending(user: CurrentUser): boolean {
  return user.mfa.enabled && !user.mfa.verified;
}

/**
 * ผู้ใช้ปัจจุบันจาก GET /auth/me — null = ยังไม่ login (หรือ session หมดอายุ)
 * ใช้ cache ของ React เพื่อเรียก API ครั้งเดียวต่อ request แม้หลาย component จะเรียก
 * error อื่น (API ล่ม) ปล่อยให้ error.tsx แสดง
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  try {
    const { user } = await apiFetch<{ user: CurrentUser }>('/auth/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
});

/**
 * หน้าที่ต้องใช้บัญชีที่พร้อมใช้งาน — ลำดับเดียวกับ requireAuth ของ API (เพื่อ UX เท่านั้น — API ตรวจเอง):
 * ยังไม่ใส่รหัส MFA → /mfa, ยังไม่รับทราบประกาศความเป็นส่วนตัว → /privacy,
 * บทบาทบังคับ MFA แต่ยังไม่ตั้งค่า → /mfa/setup, ยังไม่อนุมัติ → /pending
 */
export function redirectUnlessReady(user: CurrentUser): void {
  if (isMfaPending(user)) redirect('/mfa');
  if (!user.privacyAcknowledged) redirect('/privacy');
  if (user.mfa.required && !user.mfa.enabled) redirect('/mfa/setup');
  if (user.approvalStatus !== 'approved') redirect('/pending');
}

// Server Component ยัง import จากที่นี่ได้ ส่วน Client Component ให้ import จาก ./account-type โดยตรง
export { ACCOUNT_TYPE_LABELS } from './account-type';
