import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';
import { requireAuth, requirePermission } from '../middlewares/auth.js';
import {
  MAX_ACTIVE_CERTIFICATES,
  SELF_REVOCATION_REASONS,
  downloadMyCertificateP12,
  listMyCertificates,
  requestCertificate,
  revokeMyCertificate,
} from '../services/certificate-service.js';
import { crlToPem, getPublishedCrl } from '../services/crl-service.js';
import { PERMISSIONS } from '../services/permissions.js';

export const certificatesRouter = Router();

const requestBody = z.object({
  // ไม่ trim: ช่องว่างเป็นส่วนหนึ่งของรหัสผ่านได้
  p12Password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(128),
  legacyP12: z.boolean().default(false),
});

// สิทธิ์: ต้อง login เท่านั้น (ไม่ต้องมี permission) — ดูได้เฉพาะใบรับรองของตัวเอง
// รวมใบที่นำเข้าจากระบบเดิม ผู้ใช้จึงเห็นใบของตัวเองแม้ยังไม่ได้รับสิทธิ์ขอใบใหม่
certificatesRouter.get('/me/certificates', requireAuth, async (req, res) => {
  const certificates = await listMyCertificates(req.user!);
  res.json({ certificates, maxActive: MAX_ACTIVE_CERTIFICATES });
});

// สิทธิ์: certificate:request — ขอใบรับรองใหม่ได้ไฟล์ .p12 กลับไปครั้งเดียว (ระบบไม่เก็บไฟล์และรหัสผ่าน)
certificatesRouter.post('/me/certificates', requirePermission(PERMISSIONS.CERTIFICATE_REQUEST), async (req, res) => {
  const input = requestBody.parse(req.body);
  const { certificate, p12 } = await requestCertificate(req.user!, input);
  // ไฟล์ที่มี private key ห้ามถูกเก็บใน cache ใด ๆ
  res.set('Cache-Control', 'no-store');
  res.status(201).json({
    certificate,
    p12: p12.toString('base64'),
    fileName: `${certificate.email}.p12`,
  });
});

const certificateIdParams = z.object({ id: z.uuid() });
const revokeBody = z.object({ reason: z.enum(SELF_REVOCATION_REASONS) });

// สิทธิ์: certificate:request — เพิกถอนใบรับรองของตัวเอง (ย้อนกลับไม่ได้) แล้วออก CRL ใหม่
certificatesRouter.post(
  '/me/certificates/:id/revoke',
  requirePermission(PERMISSIONS.CERTIFICATE_REQUEST),
  async (req, res) => {
    const { id } = certificateIdParams.parse(req.params);
    const { reason } = revokeBody.parse(req.body);
    const result = await revokeMyCertificate(req.user!, id, reason);
    res.json(result);
  },
);

// สิทธิ์: certificate:request — ดาวน์โหลด .p12 ใหม่จาก key สำรอง ด้วยรหัสผ่านใหม่ (ใบรับรองเดิม)
certificatesRouter.post(
  '/me/certificates/:id/p12',
  requirePermission(PERMISSIONS.CERTIFICATE_REQUEST),
  async (req, res) => {
    const { id } = certificateIdParams.parse(req.params);
    const input = requestBody.parse(req.body);
    const { p12, fileName } = await downloadMyCertificateP12(req.user!, id, input);
    // ไฟล์ที่มี private key ห้ามถูกเก็บใน cache ใด ๆ
    res.set('Cache-Control', 'no-store');
    res.json({ p12: p12.toString('base64'), fileName });
  },
);

// สิทธิ์: public — CRL ฉบับล่าสุด ให้ cdp.msu.ac.th ดึงไปเผยแพร่ที่ URL ที่ฝังในใบรับรอง
// CRL เป็นข้อมูลสาธารณะ (มีแค่ serial และวันที่ ไม่มีชื่อ/อีเมล)
certificatesRouter.get('/crl/msu-ca.crl', async (_req, res) => {
  const crl = await getPublishedCrl();
  if (!crl) throw new AppError(404, 'CRL_NOT_AVAILABLE', 'ยังไม่มี CRL');
  // ให้ผู้ดึงตรวจฉบับใหม่ทุกครั้ง (ไม่ใช้ของเก่าใน cache)
  res.set('Cache-Control', 'no-cache');
  res.set('Last-Modified', crl.thisUpdate.toUTCString());
  if (config.crl.publishFormat === 'der') {
    res.type('application/pkix-crl').send(crl.crlDer);
  } else {
    res.type('application/x-pem-file').send(crlToPem(crl.crlDer));
  }
});
