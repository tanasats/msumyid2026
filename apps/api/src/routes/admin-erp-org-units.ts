import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requireStepUp } from '../middlewares/auth.js';
import {
  listErpOrgUnitLogsForAdmin,
  listErpOrgUnitsForAdmin,
  resetErpOrgUnitMapping,
  setErpOrgUnitMapping,
} from '../services/erp-org-unit-admin-service.js';
import { PERMISSIONS } from '../services/permissions.js';

// จับคู่หน่วยงาน ERP กับหน่วยงานในระบบ (หน้า /admin/org-units)
// สิทธิ์: org_unit:manage ทุก endpoint + ยืนยันตัวตนซ้ำ (กลุ่ม system_settings) ก่อนเปลี่ยนการจับคู่
export const adminErpOrgUnitsRouter = Router();

const listQuery = z.object({
  status: z.enum(['unmatched', 'auto', 'manual', 'all']).default('unmatched'),
  level: z.enum(['faculty', 'department']).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const idParams = z.object({ id: z.uuid() });
const reason = z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500);

// สิทธิ์: org_unit:manage — รายการหน่วยงาน ERP (แบ่งหน้า) + จำนวนที่ยังไม่จับคู่ + ตัวเลือกหน่วยงานในระบบ
adminErpOrgUnitsRouter.get('/admin/erp-org-units', requirePermission(PERMISSIONS.ORG_UNIT_MANAGE), async (req, res) => {
  const query = listQuery.parse(req.query);
  res.json(
    await listErpOrgUnitsForAdmin({
      status: query.status,
      level: query.level ?? null,
      q: query.q ? query.q : null,
      page: query.page,
    }),
  );
});

// สิทธิ์: org_unit:manage — ประวัติการจับคู่ของหน่วยงาน ERP หนึ่ง (50 รายการล่าสุด)
adminErpOrgUnitsRouter.get(
  '/admin/erp-org-units/:id/logs',
  requirePermission(PERMISSIONS.ORG_UNIT_MANAGE),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ logs: await listErpOrgUnitLogsForAdmin(id) });
  },
);

// สิทธิ์: org_unit:manage + step-up — กำหนดหน่วยงานเอง (login ครั้งถัดไปไม่ทับ) หน่วยงานของบุคลากรเปลี่ยนทันที
adminErpOrgUnitsRouter.put(
  '/admin/erp-org-units/:id/mapping',
  requirePermission(PERMISSIONS.ORG_UNIT_MANAGE),
  requireStepUp('system_settings'),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = z.object({ orgUnitId: z.uuid(), reason }).parse(req.body);
    res.json(await setErpOrgUnitMapping(req.user!, id, body));
  },
);

// สิทธิ์: org_unit:manage + step-up — คืนให้ระบบจับคู่จากชื่อ (เฉพาะที่กำหนดเองไว้)
adminErpOrgUnitsRouter.delete(
  '/admin/erp-org-units/:id/mapping',
  requirePermission(PERMISSIONS.ORG_UNIT_MANAGE),
  requireStepUp('system_settings'),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const body = z.object({ reason }).parse(req.body);
    res.json(await resetErpOrgUnitMapping(req.user!, id, body));
  },
);
