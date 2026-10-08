import { cache } from 'react';
import type { AccountType } from './account-type';
import { ApiError, apiFetch } from './api-server';

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  roles: string[];
  /** ใช้ซ่อน/แสดงเมนูเท่านั้น การตรวจสิทธิ์จริงอยู่ที่ API */
  permissions: string[];
};

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

// Server Component ยัง import จากที่นี่ได้ ส่วน Client Component ให้ import จาก ./account-type โดยตรง
export { ACCOUNT_TYPE_LABELS } from './account-type';
