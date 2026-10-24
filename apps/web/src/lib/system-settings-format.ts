import type { SystemSettingsValues } from './system-settings';

// แสดงประวัติการแก้ค่าตั้งของระบบ — ไม่ import โมดูลฝั่ง server จึงใช้ได้ทุกที่

const LABELS: Record<keyof SystemSettingsValues, string> = {
  allowedEmailDomains: 'โดเมนที่ไม่ต้องรออนุมัติ',
  sessionTtlDays: 'อายุการเข้าสู่ระบบ (วัน)',
  crlValidityDays: 'อายุ CRL (วัน)',
  crlReissueHours: 'ออก CRL ใหม่ทุก (ชั่วโมง)',
};

const format = (value: SystemSettingsValues[keyof SystemSettingsValues]) =>
  Array.isArray(value) ? value.join(', ') : String(value);

/** รายการค่าที่เปลี่ยน เช่น "อายุการเข้าสู่ระบบ (วัน): 7 → 3" */
export function describeSettingChanges(log: { before: SystemSettingsValues; after: SystemSettingsValues }): string[] {
  return (Object.keys(LABELS) as (keyof SystemSettingsValues)[])
    .filter((key) => format(log.before[key]) !== format(log.after[key]))
    .map((key) => `${LABELS[key]}: ${format(log.before[key])} → ${format(log.after[key])}`);
}
