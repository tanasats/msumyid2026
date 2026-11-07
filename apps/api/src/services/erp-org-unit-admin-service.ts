import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import {
  countUnmatchedErpOrgUnits,
  erpOrgUnitExists,
  findErpOrgUnitMappingForUpdate,
  insertErpOrgUnitMappingLog,
  listErpOrgUnitMappingLogs,
  listErpOrgUnits,
  resetErpOrgUnitMappingToAuto,
  setManualErpOrgUnitMapping,
  type ErpOrgUnitLevel,
  type ErpOrgUnitListRow,
  type ErpOrgUnitListStatus,
  type ErpOrgUnitMappingLogRow,
} from '../repositories/erp-org-unit-repository.js';
import { findActiveOrgUnit, listActiveOrgUnits, type OrgUnitRow } from '../repositories/org-unit-repository.js';
import { syncStaffOrgUnitsByErpOrgUnit } from '../repositories/user-repository.js';
import type { AuthUser } from './authorization-service.js';

// จับคู่หน่วยงาน ERP (รหัส 12 หลัก) กับหน่วยงานในระบบ (org_units) แบบกำหนดเอง — หน้า /admin/org-units (CLAUDE.md หัวข้อ 18)
// สิทธิ์ org_unit:manage ตรวจที่ route — ทุกการเปลี่ยนคำนวณหน่วยงานของบุคลากรที่ได้รับผลใหม่ทันที และเขียน log ใน transaction เดียวกัน

export const ERP_ORG_UNIT_PAGE_SIZE = 50;
const LOG_LIMIT = 50;

export type ErpOrgUnitListResult = {
  items: ErpOrgUnitListRow[];
  total: number;
  page: number;
  pageSize: number;
  unmatchedCount: number;
  /** ตัวเลือกหน่วยงานในระบบ (ส่งมาด้วยเพราะผู้มี org_unit:manage อาจไม่มี user:read ที่ใช้กับ /admin/org-units) */
  orgUnits: OrgUnitRow[];
};

export async function listErpOrgUnitsForAdmin(input: {
  status: ErpOrgUnitListStatus;
  level: ErpOrgUnitLevel | null;
  q: string | null;
  page: number;
}): Promise<ErpOrgUnitListResult> {
  const [list, unmatchedCount, orgUnits] = await Promise.all([
    listErpOrgUnits(pool, {
      status: input.status,
      level: input.level,
      q: input.q,
      limit: ERP_ORG_UNIT_PAGE_SIZE,
      offset: (input.page - 1) * ERP_ORG_UNIT_PAGE_SIZE,
    }),
    countUnmatchedErpOrgUnits(pool),
    listActiveOrgUnits(pool),
  ]);
  return { ...list, page: input.page, pageSize: ERP_ORG_UNIT_PAGE_SIZE, unmatchedCount, orgUnits };
}

export async function listErpOrgUnitLogsForAdmin(erpOrgUnitId: string): Promise<ErpOrgUnitMappingLogRow[]> {
  if (!(await erpOrgUnitExists(pool, erpOrgUnitId))) throw notFound();
  return listErpOrgUnitMappingLogs(pool, erpOrgUnitId, LOG_LIMIT);
}

/** ผู้ดูแลกำหนดหน่วยงานเอง (manual — login ครั้งถัดไปไม่ทับ) คืนจำนวนบุคลากรที่หน่วยงานเปลี่ยน */
export async function setErpOrgUnitMapping(
  actor: AuthUser,
  erpOrgUnitId: string,
  input: { orgUnitId: string; reason: string },
): Promise<{ affectedUsers: number }> {
  return withTransaction(async (client) => {
    const current = await findErpOrgUnitMappingForUpdate(client, erpOrgUnitId);
    if (!current) throw notFound();
    if (!(await findActiveOrgUnit(client, input.orgUnitId))) {
      throw new AppError(422, 'ORG_UNIT_INACTIVE', 'ไม่พบหน่วยงานที่เลือก หรือหน่วยงานนี้ปิดการใช้งานแล้ว');
    }
    if (current.matchType === 'manual' && current.orgUnitId === input.orgUnitId) {
      throw new AppError(409, 'MAPPING_UNCHANGED', 'หน่วยงานนี้จับคู่ไว้แบบกำหนดเองกับหน่วยงานที่เลือกอยู่แล้ว');
    }
    // ระบบจับคู่ auto ไว้ตรงกันแล้ว ก็บันทึกเป็น manual ได้ (กันการจับคู่เปลี่ยนเมื่อชื่อใน ERP เปลี่ยน)
    await setManualErpOrgUnitMapping(client, erpOrgUnitId, input.orgUnitId);
    const affectedUsers = await syncStaffOrgUnitsByErpOrgUnit(client, erpOrgUnitId);
    await insertErpOrgUnitMappingLog(client, {
      erpOrgUnitId,
      actorId: actor.id,
      action: 'set_manual',
      from: current,
      to: { orgUnitId: input.orgUnitId, matchType: 'manual' },
      reason: input.reason,
      affectedUsers,
    });
    return { affectedUsers };
  });
}

/** คืนให้ระบบจับคู่จากชื่อ (เฉพาะที่กำหนดเองไว้) คืนการจับคู่ใหม่และจำนวนบุคลากรที่หน่วยงานเปลี่ยน */
export async function resetErpOrgUnitMapping(
  actor: AuthUser,
  erpOrgUnitId: string,
  input: { reason: string },
): Promise<{ affectedUsers: number; matched: boolean }> {
  return withTransaction(async (client) => {
    const current = await findErpOrgUnitMappingForUpdate(client, erpOrgUnitId);
    if (!current) throw notFound();
    if (current.matchType !== 'manual') {
      throw new AppError(409, 'MAPPING_NOT_MANUAL', 'หน่วยงานนี้ไม่ได้จับคู่แบบกำหนดเอง ระบบจับคู่จากชื่ออยู่แล้ว');
    }
    const next = await resetErpOrgUnitMappingToAuto(client, erpOrgUnitId);
    const affectedUsers = await syncStaffOrgUnitsByErpOrgUnit(client, erpOrgUnitId);
    await insertErpOrgUnitMappingLog(client, {
      erpOrgUnitId,
      actorId: actor.id,
      action: 'reset_auto',
      from: current,
      to: next,
      reason: input.reason,
      affectedUsers,
    });
    return { affectedUsers, matched: next.orgUnitId !== null };
  });
}

const notFound = () => new AppError(404, 'ERP_ORG_UNIT_NOT_FOUND', 'ไม่พบหน่วยงาน ERP นี้');
