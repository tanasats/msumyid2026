import { apiFetch } from './api-server';

// ค่าตั้งของระบบ (super_admin เท่านั้น — API ตรวจ) ชนิดข้อมูลใช้ได้ทั้ง Server และ Client Component ผ่าน import type

export type SystemSettingsValues = {
  allowedEmailDomains: string[];
  sessionTtlDays: number;
  crlValidityDays: number;
  crlReissueHours: number;
  primaryReissueLimit: number;
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
