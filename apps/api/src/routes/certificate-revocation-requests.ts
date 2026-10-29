import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import {
  REVOCATION_REQUEST_REASONS,
  cancelMyRevocationRequest,
  decideRevocationRequestByAdmin,
  listMyRevocationRequests,
  listRevocationRequestsForAdmin,
  submitRevocationRequest,
} from '../services/certificate-revocation-request-service.js';

// คำขอเพิกถอนใบรับรองประจำตัว (docs/design/certificates.md หัวข้อ "การควบคุมการเพิกถอน")
export const certificateRevocationRequestsRouter = Router();

const idParams = z.object({ id: z.uuid() });

const optionalNote = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .transform((v) => v || null);

const listQuery = z.object({
  view: z.enum(['pending', 'all', 'approved', 'rejected', 'cancelled']).default('pending'),
  cursor: z.uuid().optional(),
});

// ---- ผู้ขอ ----

// สิทธิ์: ต้อง login เท่านั้น — ดูได้เฉพาะคำขอของตัวเอง (เห็นผลคำขอเดิมแม้ถูกเปลี่ยนสิทธิ์แล้ว)
certificateRevocationRequestsRouter.get('/me/certificate-revocation-requests', requireAuth, async (req, res) => {
  res.json(await listMyRevocationRequests(req.user!));
});

// สิทธิ์: ตามประเภทใบ (ตรวจใน service เหมือนการเพิกถอน) — ส่งคำขอเพิกถอนใบประจำตัวของตัวเอง
certificateRevocationRequestsRouter.post('/me/certificates/:id/revocation-requests', requireAuth, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = z.object({ reason: z.enum(REVOCATION_REQUEST_REASONS) }).parse(req.body);
  res.status(201).json({ request: await submitRevocationRequest(req.user!, id, reason) });
});

// สิทธิ์: ต้อง login เท่านั้น — ยกเลิกคำขอของตัวเองที่ยังรออนุมัติ (ไม่ต้องมีสิทธิ์จัดการใบ: ยกเลิกแล้วไม่มีอะไรเกิดกับใบ)
certificateRevocationRequestsRouter.post(
  '/me/certificate-revocation-requests/:id/cancel',
  requireAuth,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ request: await cancelMyRevocationRequest(req.user!, id) });
  },
);

// ---- ผู้อนุมัติ ----

// สิทธิ์: certificate:revoke — คิวรออนุมัติ (เก่าก่อน) หรือประวัติ (ล่าสุดก่อน, cursor หน้าละ 20)
certificateRevocationRequestsRouter.get(
  '/admin/certificate-revocation-requests',
  requirePermission(PERMISSIONS.CERTIFICATE_REVOKE),
  async (req, res) => {
    const { view, cursor } = listQuery.parse(req.query);
    res.json(await listRevocationRequestsForAdmin({ view, cursor: cursor ?? null }));
  },
);

// สิทธิ์: certificate:revoke — อนุมัติ = เพิกถอนใบทันทีแล้วออก CRL (บันทึกไม่บังคับ) ตามกฎ canManageUser
certificateRevocationRequestsRouter.post(
  '/admin/certificate-revocation-requests/:id/approve',
  requirePermission(PERMISSIONS.CERTIFICATE_REVOKE),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { note } = z.object({ note: optionalNote }).parse(req.body);
    res.json(await decideRevocationRequestByAdmin(req.user!, id, { decision: 'approve', note }));
  },
);

// สิทธิ์: certificate:revoke — ปฏิเสธพร้อมเหตุผล (ผู้ขอเห็น) ตามกฎ canManageUser
certificateRevocationRequestsRouter.post(
  '/admin/certificate-revocation-requests/:id/reject',
  requirePermission(PERMISSIONS.CERTIFICATE_REVOKE),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(1000) }).parse(req.body);
    res.json(await decideRevocationRequestByAdmin(req.user!, id, { decision: 'reject', note }));
  },
);
