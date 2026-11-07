import { apiFetch } from './api-server';
import type { ErpOrgUnitLevel, ErpOrgUnitList, ErpOrgUnitStatus } from './erp-org-unit';

export type ErpOrgUnitQuery = { status: ErpOrgUnitStatus; level?: ErpOrgUnitLevel; q?: string; page: number };

/** รายการหน่วยงาน ERP สำหรับหน้าจับคู่ (ต้องมี org_unit:manage — API ตรวจ) */
export async function listErpOrgUnits(query: ErpOrgUnitQuery): Promise<ErpOrgUnitList> {
  const params = new URLSearchParams({ status: query.status, page: String(query.page) });
  if (query.level) params.set('level', query.level);
  if (query.q) params.set('q', query.q);
  return apiFetch(`/admin/erp-org-units?${params}`);
}
