// ชนิดข้อมูลของหน้าจับคู่หน่วยงาน ERP (ใช้ได้ทั้ง server และ client — ไม่ import next/headers)

export type ErpOrgUnitStatus = 'unmatched' | 'auto' | 'manual' | 'all';
export type ErpOrgUnitLevel = 'faculty' | 'department';
export type ErpOrgUnitMatchType = 'auto' | 'manual';

export type OrgUnitOption = { id: string; code: string; nameTh: string };

export type ErpOrgUnitItem = {
  id: string;
  erpCode: string;
  nameTh: string;
  level: ErpOrgUnitLevel;
  matchType: ErpOrgUnitMatchType | null;
  orgUnit: OrgUnitOption | null;
  staffCount: number;
  updatedAt: string;
};

export type ErpOrgUnitList = {
  items: ErpOrgUnitItem[];
  total: number;
  page: number;
  pageSize: number;
  unmatchedCount: number;
  orgUnits: OrgUnitOption[];
};

type MappingSide = { orgUnitName: string | null; matchType: ErpOrgUnitMatchType | null };

export type ErpOrgUnitMappingLog = {
  id: string;
  action: 'set_manual' | 'reset_auto';
  actor: { id: string; displayName: string } | null;
  from: MappingSide;
  to: MappingSide;
  reason: string;
  affectedUsers: number;
  createdAt: string;
};

export const LEVEL_LABELS: Record<ErpOrgUnitLevel, string> = {
  faculty: 'คณะ/สำนัก',
  department: 'กอง/ฝ่าย',
};

export const MATCH_TYPE_LABELS: Record<ErpOrgUnitMatchType, string> = {
  auto: 'อัตโนมัติ',
  manual: 'กำหนดเอง',
};

/** ข้อความของการจับคู่ด้านหนึ่งในประวัติ เช่น "คณะวิทยาการสารสนเทศ (กำหนดเอง)" */
export const describeMappingSide = (side: MappingSide) =>
  side.orgUnitName ? `${side.orgUnitName} (${side.matchType ? MATCH_TYPE_LABELS[side.matchType] : '—'})` : 'ยังไม่จับคู่';
