// คำขอใบรับรองเสริม — ชนิดข้อมูลและตัวช่วยแสดงผล ใช้ได้ทั้ง Server และ Client Component (ไม่ import โมดูลฝั่ง server)
// API (supplementary-certificate-service.ts) ตรวจช่วงวันที่และเพดานจริงทุกครั้ง ส่วนนี้ใช้แสดงผล/ตรวจล่วงหน้าเท่านั้น

import type { AccountType } from './account-type';

/** expired = อนุมัติแล้วแต่ไม่ได้รับใบจนเลยวันสิ้นสุด */
export type SupplementaryRequestStatus = 'pending' | 'approved' | 'issued' | 'rejected' | 'cancelled' | 'expired';

export type SupplementaryRequest = {
  id: string;
  purpose: string;
  /** วันที่ YYYY-MM-DD ตามเวลาประเทศไทย */
  requestedStart: string;
  requestedEnd: string;
  approvedStart: string | null;
  approvedEnd: string | null;
  status: SupplementaryRequestStatus;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  certificateId: string | null;
  createdAt: string;
};

export type AdminSupplementaryRequest = SupplementaryRequest & {
  /** null = ผู้ขอถูกลบบัญชีแล้ว */
  requester: { id: string; displayName: string; email: string; accountType: AccountType } | null;
};

export type SupplementaryLimits = {
  maxDays: number;
  maxLeadDays: number;
  /** 0 = ปิดการขอใบเสริม */
  maxActive: number;
  /** ใบเสริมที่ใช้งานอยู่ + คำขอที่ค้าง */
  open: number;
  /** วันนี้ตามเวลาประเทศไทย (จาก API ไม่ใช้นาฬิกาเครื่องผู้ใช้) */
  today: string;
};

export const SUPPLEMENTARY_STATUS_LABELS: Record<SupplementaryRequestStatus, string> = {
  pending: 'รออนุมัติ',
  approved: 'อนุมัติแล้ว รอรับใบ',
  issued: 'รับใบแล้ว',
  rejected: 'ไม่อนุมัติ',
  cancelled: 'ยกเลิก',
  expired: 'หมดเวลารับใบ',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** วันที่ห่างจาก date ไป days วัน (YYYY-MM-DD) */
export function addDays(date: string, days: number): string {
  return new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** จำนวนวันของช่วง นับวันแรกและวันสุดท้าย — ตรงกับ rangeDays ของ API */
export function rangeDays(start: string, end: string): number {
  return Math.round((utc(end) - utc(start)) / DAY_MS) + 1;
}

const dayFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'UTC' });

/** ช่วงวันที่แบบอ่านง่าย เช่น "1 พ.ย. 2569 – 7 พ.ย. 2569 (7 วัน)" */
export function formatRange(start: string, end: string): string {
  const days = rangeDays(start, end);
  const from = dayFormatter.format(new Date(utc(start)));
  return start === end ? `${from} (1 วัน)` : `${from} – ${dayFormatter.format(new Date(utc(end)))} (${days} วัน)`;
}

/**
 * ตรวจช่วงวันที่ล่วงหน้าตามเพดาน (ข้อความเดียวกับ API) — คืนข้อความ error หรือ null
 * mode approve: วันเริ่มผ่านไปแล้วได้ แต่ต้องยังไม่สิ้นสุด
 */
export function validateRange(
  range: { startDate: string; endDate: string },
  limits: Pick<SupplementaryLimits, 'maxDays' | 'maxLeadDays' | 'today'>,
  mode: 'submit' | 'approve',
): { field: 'startDate' | 'endDate'; message: string } | null {
  if (!range.startDate) return { field: 'startDate', message: 'กรุณาเลือกวันเริ่ม' };
  if (!range.endDate) return { field: 'endDate', message: 'กรุณาเลือกวันสิ้นสุด' };
  if (range.endDate < range.startDate) return { field: 'endDate', message: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม' };
  if (mode === 'submit' && range.startDate < limits.today) {
    return { field: 'startDate', message: 'วันเริ่มต้องไม่ย้อนหลัง' };
  }
  if (mode === 'approve' && range.endDate < limits.today) {
    return { field: 'endDate', message: 'ช่วงวันที่นี้สิ้นสุดไปแล้ว' };
  }
  if (range.startDate > addDays(limits.today, limits.maxLeadDays)) {
    return { field: 'startDate', message: `วันเริ่มล่วงหน้าได้ไม่เกิน ${limits.maxLeadDays} วันนับจากวันนี้` };
  }
  if (rangeDays(range.startDate, range.endDate) > limits.maxDays) {
    return { field: 'endDate', message: `ช่วงวันที่ยาวได้ไม่เกิน ${limits.maxDays} วัน` };
  }
  return null;
}
