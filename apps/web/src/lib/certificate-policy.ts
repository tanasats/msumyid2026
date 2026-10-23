// นโยบายอายุใบรับรอง — ชนิดข้อมูลและการคำนวณตัวอย่างวันหมดอายุ ใช้ได้ทั้ง Server และ Client Component
// API (certificate-policy-service.ts) เป็นผู้คำนวณจริงตอนออกใบ ส่วนนี้ใช้แสดงตัวอย่างในฟอร์มเท่านั้น

export type PrimaryValidityMode = 'days' | 'fixed_date';

export type CertificatePolicySettings = {
  primaryMode: PrimaryValidityMode;
  primaryDays: number;
  primaryExpiryMonth: number;
  primaryExpiryDay: number;
  primaryMinDays: number;
  renewalWindowDays: number;
  supplementaryMaxDays: number;
  supplementaryMaxActive: number;
};

export type CertificatePolicy = CertificatePolicySettings & {
  updatedAt: string;
  updatedBy: { id: string; displayName: string } | null;
};

export type CertificatePolicyLog = {
  id: string;
  actor: { id: string; displayName: string } | null;
  before: CertificatePolicySettings;
  after: CertificatePolicySettings;
  createdAt: string;
};

export const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
] as const;

/** วันสุดท้ายของเดือน (ไม่นับ 29 ก.พ.) — ตรงกับที่ API ตรวจ */
export const MAX_DAY_OF_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/** ตัวอย่างวันหมดอายุของใบประจำตัวถ้าออก ณ เวลา now (ตรรกะเดียวกับ primaryValidityDays ของ API) */
export function previewPrimaryExpiry(policy: CertificatePolicySettings, now: Date): Date | null {
  if (policy.primaryMode === 'days') {
    return policy.primaryDays >= 1 ? new Date(now.getTime() + policy.primaryDays * DAY_MS) : null;
  }
  const year = new Date(now.getTime() + BANGKOK_OFFSET_MS).getUTCFullYear();
  for (const candidate of [year, year + 1]) {
    const end = Date.UTC(candidate, policy.primaryExpiryMonth - 1, policy.primaryExpiryDay, 23, 59, 59) - BANGKOK_OFFSET_MS;
    const days = Math.floor((end - now.getTime()) / DAY_MS);
    if (days >= Math.max(policy.primaryMinDays, 1)) return new Date(now.getTime() + days * DAY_MS);
  }
  return null;
}

/** สรุปนโยบายใบประจำตัวเป็นประโยคสั้น */
export function describePrimaryPolicy(policy: CertificatePolicySettings): string {
  return policy.primaryMode === 'days'
    ? `อายุ ${policy.primaryDays} วันนับจากวันที่ออก`
    : `หมดอายุวันที่ ${policy.primaryExpiryDay} ${THAI_MONTHS[policy.primaryExpiryMonth - 1]} (ขั้นต่ำ ${policy.primaryMinDays} วัน)`;
}

const FIELD_LABELS: Record<keyof CertificatePolicySettings, string> = {
  primaryMode: 'วิธีกำหนดอายุใบประจำตัว',
  primaryDays: 'อายุใบประจำตัว (วัน)',
  primaryExpiryMonth: 'เดือนที่หมดอายุ',
  primaryExpiryDay: 'วันที่หมดอายุ',
  primaryMinDays: 'อายุขั้นต่ำ (วัน)',
  renewalWindowDays: 'ช่วงต่ออายุ (วัน)',
  supplementaryMaxDays: 'อายุสูงสุดของใบเสริม (วัน)',
  supplementaryMaxActive: 'ใบเสริมพร้อมกันต่อคน',
};

const MODE_LABELS: Record<PrimaryValidityMode, string> = {
  days: 'นับจำนวนวัน',
  fixed_date: 'หมดอายุวันที่กำหนด',
};

function formatValue(key: keyof CertificatePolicySettings, value: CertificatePolicySettings[typeof key]): string {
  if (key === 'primaryMode') return MODE_LABELS[value as PrimaryValidityMode];
  if (key === 'primaryExpiryMonth') return THAI_MONTHS[(value as number) - 1] ?? String(value);
  return String(value);
}

/** รายการค่าที่เปลี่ยนในประวัติการแก้ เช่น "อายุใบประจำตัว (วัน): 365 → 180" */
export function describePolicyChanges(log: Pick<CertificatePolicyLog, 'before' | 'after'>): string[] {
  return (Object.keys(FIELD_LABELS) as (keyof CertificatePolicySettings)[])
    .filter((key) => log.before[key] !== log.after[key])
    .map((key) => `${FIELD_LABELS[key]}: ${formatValue(key, log.before[key])} → ${formatValue(key, log.after[key])}`);
}
