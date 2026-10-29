// คำขอเพิกถอนใบรับรองประจำตัว — ชนิดข้อมูลและป้าย ใช้ได้ทั้ง Server และ Client Component

import type { AccountType } from './account-type';

export type RevocationRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type RevocationRequestReason = 'superseded' | 'affiliationChanged' | 'cessationOfOperation';

export type RevocationRequest = {
  id: string;
  certificate: { id: string; serialNumber: string; notAfter: string };
  reason: RevocationRequestReason;
  status: RevocationRequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
};

export type AdminRevocationRequest = RevocationRequest & {
  requester: { id: string; displayName: string; email: string; accountType: AccountType } | null;
};

export const REVOCATION_REQUEST_STATUS_LABELS: Record<RevocationRequestStatus, string> = {
  pending: 'รออนุมัติ',
  approved: 'เพิกถอนแล้ว',
  rejected: 'ไม่อนุมัติ',
  cancelled: 'ยกเลิก',
};

/**
 * เหตุผลที่ใบประจำตัวเพิกถอนเองได้ทันที (ตรงกับ URGENT_REVOCATION_REASONS ของ API) — เหตุผลอื่นต้องส่งคำขอ
 * ใบเสริมเพิกถอนเองได้ทุกเหตุผล
 */
export const URGENT_REVOCATION_REASONS: readonly string[] = ['keyCompromise'];
