import type { StepUpAction, SystemSettingsValues } from './system-settings';

// แสดงประวัติการแก้ค่าตั้งของระบบ — ไม่ import โมดูลฝั่ง server จึงใช้ได้ทุกที่

const LABELS: Record<keyof SystemSettingsValues, string> = {
  allowedEmailDomains: 'โดเมนที่ไม่ต้องรออนุมัติ',
  sessionTtlDays: 'อายุการเข้าสู่ระบบ (วัน)',
  crlValidityDays: 'อายุ CRL (วัน)',
  crlReissueHours: 'ออก CRL ใหม่ทุก (ชั่วโมง)',
  primaryReissueLimit: 'เพิกถอนแล้วขอใบใหม่เองได้ (ครั้ง/ปี)',
  mfaStepUpActions: 'รายการที่ต้องยืนยันตัวตนซ้ำ',
};

/** กลุ่มรายการที่ต้องยืนยันตัวตนซ้ำ เรียงตามที่แสดงในฟอร์ม */
export const STEP_UP_ACTIONS: { value: StepUpAction; label: string; hint: string }[] = [
  { value: 'certificate', label: 'ใบรับรอง', hint: 'ขอใบรับรอง, ดาวน์โหลด .p12 จาก key สำรอง, รับใบจากคำขอที่อนุมัติแล้ว' },
  { value: 'role', label: 'role และสิทธิ์', hint: 'ให้/ถอน role ของผู้ใช้, สร้าง/แก้ role และสิทธิ์ของ role' },
  { value: 'system_settings', label: 'ค่าตั้งของระบบ', hint: 'บันทึกค่าในหน้านี้' },
  { value: 'user_admin', label: 'บัญชีผู้ใช้', hint: 'ลบบัญชีผู้ใช้, รีเซ็ตการยืนยันตัวตนสองขั้นตอนของผู้อื่น' },
];

const STEP_UP_LABELS = new Map(STEP_UP_ACTIONS.map((a) => [a.value as string, a.label]));

const format = (key: keyof SystemSettingsValues, value: SystemSettingsValues[keyof SystemSettingsValues] | undefined) => {
  if (key === 'mfaStepUpActions' && Array.isArray(value)) {
    return value.length === 0 ? 'ปิดทั้งหมด' : value.map((v) => STEP_UP_LABELS.get(v) ?? v).join(', ');
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
};

/** รายการค่าที่เปลี่ยน เช่น "อายุการเข้าสู่ระบบ (วัน): 7 → 3" */
export function describeSettingChanges(log: { before: SystemSettingsValues; after: SystemSettingsValues }): string[] {
  return (Object.keys(LABELS) as (keyof SystemSettingsValues)[])
    // ประวัติก่อนมีค่าใหม่ไม่มี key นั้น — ข้าม (ไม่ได้เปลี่ยนในครั้งนั้น)
    .filter((key) => log.before[key] !== undefined && log.after[key] !== undefined)
    .filter((key) => format(key, log.before[key]) !== format(key, log.after[key]))
    .map((key) => `${LABELS[key]}: ${format(key, log.before[key])} → ${format(key, log.after[key])}`);
}
