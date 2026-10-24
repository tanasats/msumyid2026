import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { completeUpload, createUpload, getDownloadUrl } from '../services/file-service.js';
import { PERMISSIONS } from '../services/permissions.js';

// ไฟล์ของผู้ใช้ใน storage (ใช้กับการลงนามเอกสาร) — browser อัปโหลด/ดาวน์โหลดตรงด้วย presigned URL
export const filesRouter = Router();

const createBody = z.object({
  purpose: z.enum(['signing_source', 'signature_image']),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().positive(),
});
const fileParams = z.object({ id: z.uuid() });

// สิทธิ์: document:sign — ขอ URL อัปโหลด (ตรวจชนิด/ขนาดก่อนออก URL อายุ 10 นาที)
filesRouter.post('/me/files', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  res.status(201).json(await createUpload(req.user!, createBody.parse(req.body)));
});

// สิทธิ์: document:sign — ยืนยันว่าอัปโหลดเสร็จ (ตรวจขนาด/ชนิดของไฟล์ใน storage)
filesRouter.post('/me/files/:id/complete', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  const { id } = fileParams.parse(req.params);
  res.json({ file: await completeUpload(req.user!, id) });
});

// สิทธิ์: document:sign — URL ดาวน์โหลดไฟล์ของตัวเอง (อายุ 5 นาที)
filesRouter.get('/me/files/:id/download', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  const { id } = fileParams.parse(req.params);
  res.set('Cache-Control', 'no-store');
  res.json(await getDownloadUrl(req.user!, id));
});
