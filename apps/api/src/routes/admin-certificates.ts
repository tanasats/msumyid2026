import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import {
  ADMIN_REVOCATION_REASONS,
  adminRevokeCertificate,
  listUserCertificatesForAdmin,
  searchCertificatesForAdmin,
} from '../services/certificate-service.js';
import { PERMISSIONS } from '../services/permissions.js';

export const adminCertificatesRouter = Router();

const listQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
  status: z
    .enum(['active', 'expired', 'revoked'])
    .optional()
    .transform((v) => v ?? null),
  cursor: z
    .uuid()
    .optional()
    .transform((v) => v ?? null),
});

const idParams = z.object({ id: z.uuid() });

const revokeBody = z.object({
  reason: z.enum(ADMIN_REVOCATION_REASONS),
  // บันทึกประกอบ (บังคับ) เก็บใน audit log — ห้ามใส่ข้อมูลส่วนบุคคล
  note: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500),
});

// สิทธิ์: certificate:read — ค้นหาใบรับรองทั้งระบบ (ชื่อ/อีเมล/serial) กรองสถานะ แบ่งหน้าแบบ cursor
adminCertificatesRouter.get('/admin/certificates', requirePermission(PERMISSIONS.CERTIFICATE_READ), async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  res.json(await searchCertificatesForAdmin(query));
});

// สิทธิ์: certificate:read — ใบรับรองของผู้ใช้คนหนึ่ง (หน้ารายละเอียดผู้ใช้)
adminCertificatesRouter.get(
  '/admin/users/:id/certificates',
  requirePermission(PERMISSIONS.CERTIFICATE_READ),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    res.json({ certificates: await listUserCertificatesForAdmin(id) });
  },
);

// สิทธิ์: certificate:revoke — เพิกถอนใบรับรองของผู้อื่น (กฎเจ้าของใบตรวจใน service) แล้วออก CRL ใหม่
adminCertificatesRouter.post(
  '/admin/certificates/:id/revoke',
  requirePermission(PERMISSIONS.CERTIFICATE_REVOKE),
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { reason, note } = revokeBody.parse(req.body);
    res.json(await adminRevokeCertificate(req.user!, id, reason, note));
  },
);
