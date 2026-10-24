import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import {
  approveSupplementaryRequest,
  listSupplementaryRequestsForAdmin,
  rejectSupplementaryRequest,
} from '../services/supplementary-certificate-service.js';

// ผู้อนุมัติคำขอใบรับรองเสริม (certificate:approve)
export const adminSupplementaryRequestsRouter = Router();

const listQuery = z.object({
  view: z.enum(['pending', 'all', 'approved', 'issued', 'rejected', 'cancelled', 'expired']).default('pending'),
  cursor: z.uuid().optional(),
});

const requestIdParams = z.object({ id: z.uuid() });

const approveBody = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    // บันทึกถึงผู้ขอ (ไม่บังคับ) — ว่าง = ไม่มี
    note: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => v || null),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม', path: ['endDate'] });

const rejectBody = z.object({ note: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(1000) });

// สิทธิ์: certificate:approve — คิวคำขอที่รออนุมัติ (เก่าก่อน) หรือประวัติที่ตัดสินแล้ว (ล่าสุดก่อน, cursor หน้าละ 20)
adminSupplementaryRequestsRouter.get(
  '/admin/supplementary-certificate-requests',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { view, cursor } = listQuery.parse(req.query);
    res.json(await listSupplementaryRequestsForAdmin({ view, cursor: cursor ?? null }));
  },
);

// สิทธิ์: certificate:approve — อนุมัติ (กำหนดช่วงวันที่ได้ภายในนโยบาย) ตามกฎ canManageUser (super_admin ตัดสินได้ทุกคำขอ)
adminSupplementaryRequestsRouter.post(
  '/admin/supplementary-certificate-requests/:id/approve',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const input = approveBody.parse(req.body);
    res.json({ request: await approveSupplementaryRequest(req.user!, id, input) });
  },
);

// สิทธิ์: certificate:approve — ปฏิเสธพร้อมเหตุผล ตามกฎ canManageUser (super_admin ตัดสินได้ทุกคำขอ)
adminSupplementaryRequestsRouter.post(
  '/admin/supplementary-certificate-requests/:id/reject',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const { note } = rejectBody.parse(req.body);
    res.json({ request: await rejectSupplementaryRequest(req.user!, id, note) });
  },
);
