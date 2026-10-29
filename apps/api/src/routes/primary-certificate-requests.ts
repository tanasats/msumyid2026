import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import {
  cancelMyPrimaryRequest,
  claimPrimaryCertificate,
  decidePrimaryCertificateRequest,
  listMyPrimaryRequests,
  listPrimaryRequestsForAdmin,
  submitPrimaryRequest,
} from '../services/primary-certificate-request-service.js';
import { p12Body } from './certificates.js';

// คำขอใบรับรองประจำตัวแบบรออนุมัติ (docs/design/certificates.md หัวข้อ "ใบประจำตัวแบบส่งคำขอ")
export const primaryCertificateRequestsRouter = Router();

const requestIdParams = z.object({ id: z.uuid() });

const submitBody = z.object({
  // ไม่บังคับ — ว่าง = ไม่มี
  purpose: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || null),
});

const optionalNote = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .transform((v) => v || null);

const listQuery = z.object({
  view: z.enum(['pending', 'all', 'approved', 'issued', 'rejected', 'cancelled', 'expired']).default('pending'),
  cursor: z.uuid().optional(),
});

// ---- ผู้ขอ ----

// สิทธิ์: ต้อง login เท่านั้น — ดูได้เฉพาะคำขอของตัวเอง (เห็นผลคำขอเดิมแม้ถูกเปลี่ยนสิทธิ์แล้ว)
primaryCertificateRequestsRouter.get('/me/primary-certificate-requests', requireAuth, async (req, res) => {
  res.json({ requests: await listMyPrimaryRequests(req.user!) });
});

// สิทธิ์: certificate:apply หรือ certificate:request ที่เพิกถอนเกินโควตา (ตรวจใน service) — ส่งคำขอใบประจำตัว (รอผู้มี certificate:approve อนุมัติ)
primaryCertificateRequestsRouter.post(
  '/me/primary-certificate-requests',
  requireAuth,
  async (req, res) => {
    const input = submitBody.parse(req.body);
    res.status(201).json({ request: await submitPrimaryRequest(req.user!, input) });
  },
);

// สิทธิ์: certificate:apply หรือ certificate:request (ตรวจใน service) — ยกเลิกคำขอของตัวเองที่ยังไม่ออกใบ
primaryCertificateRequestsRouter.post(
  '/me/primary-certificate-requests/:id/cancel',
  requireAuth,
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    res.json({ request: await cancelMyPrimaryRequest(req.user!, id) });
  },
);

// สิทธิ์: certificate:apply หรือ certificate:request (ตรวจใน service) — รับใบรับรองจากคำขอที่อนุมัติแล้ว ได้ไฟล์ .p12 กลับไปครั้งเดียว
primaryCertificateRequestsRouter.post(
  '/me/primary-certificate-requests/:id/certificate',
  requireAuth,
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const { certificate, p12, fileName } = await claimPrimaryCertificate(req.user!, id, p12Body.parse(req.body));
    // ไฟล์ที่มี private key ห้ามถูกเก็บใน cache ใด ๆ
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ certificate, p12: p12.toString('base64'), fileName });
  },
);

// ---- ผู้อนุมัติ ----

// สิทธิ์: certificate:approve — คิวรออนุมัติ (เก่าก่อน) หรือประวัติที่ตัดสินแล้ว (ล่าสุดก่อน, cursor หน้าละ 20)
primaryCertificateRequestsRouter.get(
  '/admin/primary-certificate-requests',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { view, cursor } = listQuery.parse(req.query);
    res.json(await listPrimaryRequestsForAdmin({ view, cursor: cursor ?? null }));
  },
);

// สิทธิ์: certificate:approve — อนุมัติ (บันทึกไม่บังคับ) ตามกฎ canManageUser (super_admin ตัดสินได้ทุกคำขอ)
primaryCertificateRequestsRouter.post(
  '/admin/primary-certificate-requests/:id/approve',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const { note } = z.object({ note: optionalNote }).parse(req.body);
    res.json({ request: await decidePrimaryCertificateRequest(req.user!, id, { decision: 'approve', note }) });
  },
);

// สิทธิ์: certificate:approve — ปฏิเสธพร้อมเหตุผล ตามกฎ canManageUser
primaryCertificateRequestsRouter.post(
  '/admin/primary-certificate-requests/:id/reject',
  requirePermission(PERMISSIONS.CERTIFICATE_APPROVE),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(1000) }).parse(req.body);
    res.json({ request: await decidePrimaryCertificateRequest(req.user!, id, { decision: 'reject', note }) });
  },
);
