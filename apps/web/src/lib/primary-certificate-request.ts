// คำขอใบรับรองประจำตัว (แบบรออนุมัติ) — ชนิดข้อมูลและป้าย ใช้ได้ทั้ง Server และ Client Component

import type { AccountType } from './account-type';

/** expired = อนุมัติแล้วแต่ไม่รับใบภายใน 30 วัน */
export type PrimaryRequestStatus = 'pending' | 'approved' | 'issued' | 'rejected' | 'cancelled' | 'expired';

export type PrimaryRequest = {
  id: string;
  purpose: string | null;
  status: PrimaryRequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  /** วันสุดท้ายที่รับใบได้ (มีค่าเมื่ออนุมัติแล้ว) */
  claimableUntil: string | null;
  decisionNote: string | null;
  certificateId: string | null;
  createdAt: string;
};

export type AdminPrimaryRequest = PrimaryRequest & {
  requester: { id: string; displayName: string; email: string; accountType: AccountType } | null;
};

/** วิธีขอใบประจำตัวของ role — คำนวณจาก permission ที่ผูก (certificate:request ชนะ certificate:apply) */
export type CertificateRequestMode = 'off' | 'apply' | 'self';

export function certificateModeOf(permissionCodes: string[]): CertificateRequestMode {
  if (permissionCodes.includes('certificate:request')) return 'self';
  if (permissionCodes.includes('certificate:apply')) return 'apply';
  return 'off';
}

export const CERTIFICATE_MODE_LABELS: Record<CertificateRequestMode, string> = {
  off: 'ปิด',
  apply: 'ส่งคำขอ',
  self: 'สร้างเองได้',
};
