import { apiFetch } from './api-server';

// ค่าตั้งของระบบ (super_admin เท่านั้น — API ตรวจ) ชนิดข้อมูลใช้ได้ทั้ง Server และ Client Component ผ่าน import type

/** กลุ่มรายการที่ต้องยืนยันตัวตนซ้ำ — ตรงกับ MFA_STEP_UP_ACTIONS ของ API (ป้ายอยู่ใน system-settings-format) */
export type StepUpAction = 'certificate' | 'role' | 'system_settings' | 'user_admin';

export type SystemSettingsValues = {
  allowedEmailDomains: string[];
  sessionTtlDays: number;
  crlValidityDays: number;
  crlReissueHours: number;
  primaryReissueLimit: number;
  /** กลุ่มที่เปิดอยู่ (ประวัติก่อนมีค่านี้ = undefined) */
  mfaStepUpActions: StepUpAction[];
};

export type SystemSettings = SystemSettingsValues & {
  updatedAt: string;
  updatedBy: { id: string; displayName: string } | null;
};

export type SystemSettingLog = {
  id: string;
  actor: { id: string; displayName: string } | null;
  before: SystemSettingsValues;
  after: SystemSettingsValues;
  reason: string;
  createdAt: string;
};

export async function getSystemSettings(): Promise<{ settings: SystemSettings; logs: SystemSettingLog[] }> {
  return apiFetch('/admin/system-settings');
}
