import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import {
  cancelMySupplementaryRequest,
  claimSupplementaryCertificate,
  getMySupplementaryOverview,
  submitSupplementaryRequest,
} from '../services/supplementary-certificate-service.js';
import { p12Body } from './certificates.js';

// คำขอใบรับรองเสริมของผู้ใช้ปัจจุบัน (docs/design/certificates.md หัวข้อ "ใบรับรองเสริม")
export const supplementaryCertificatesRouter = Router();

const requestBody = z
  .object({
    purpose: z.string().trim().min(1, 'กรุณาระบุวัตถุประสงค์').max(1000),
    // วันที่ตามปฏิทิน (YYYY-MM-DD) ตามเวลาประเทศไทย
    startDate: z.iso.date(),
    endDate: z.iso.date(),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม', path: ['endDate'] });

const requestIdParams = z.object({ id: z.uuid() });

// สิทธิ์: ต้อง login เท่านั้น — ดูได้เฉพาะคำขอของตัวเอง (เห็นผลคำขอเดิมแม้ถูกถอนสิทธิ์ขอแล้ว)
supplementaryCertificatesRouter.get('/me/supplementary-certificate-requests', requireAuth, async (req, res) => {
  res.json(await getMySupplementaryOverview(req.user!));
});

// สิทธิ์: supplementary_certificate:request — ส่งคำขอใบเสริม (รอผู้มี certificate:approve อนุมัติ)
supplementaryCertificatesRouter.post(
  '/me/supplementary-certificate-requests',
  requirePermission(PERMISSIONS.SUPPLEMENTARY_CERTIFICATE_REQUEST),
  async (req, res) => {
    const input = requestBody.parse(req.body);
    res.status(201).json({ request: await submitSupplementaryRequest(req.user!, input) });
  },
);

// สิทธิ์: supplementary_certificate:request — ยกเลิกคำขอของตัวเองที่ยังไม่ออกใบ
supplementaryCertificatesRouter.post(
  '/me/supplementary-certificate-requests/:id/cancel',
  requirePermission(PERMISSIONS.SUPPLEMENTARY_CERTIFICATE_REQUEST),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    res.json({ request: await cancelMySupplementaryRequest(req.user!, id) });
  },
);

// สิทธิ์: supplementary_certificate:request — รับใบรับรองจากคำขอที่อนุมัติแล้ว ได้ไฟล์ .p12 กลับไปครั้งเดียว
supplementaryCertificatesRouter.post(
  '/me/supplementary-certificate-requests/:id/certificate',
  requirePermission(PERMISSIONS.SUPPLEMENTARY_CERTIFICATE_REQUEST),
  async (req, res) => {
    const { id } = requestIdParams.parse(req.params);
    const input = p12Body.parse(req.body);
    const { certificate, p12, fileName } = await claimSupplementaryCertificate(req.user!, id, input);
    // ไฟล์ที่มี private key ห้ามถูกเก็บใน cache ใด ๆ
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ certificate, p12: p12.toString('base64'), fileName });
  },
);
