import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import { PIN_PATTERN } from '../services/signing-pin-service.js';
import { createSigningBatch, getMySigningBatch, listMySigningBatches } from '../services/signing-service.js';

// ลงนามเอกสารบนเว็บ (docs/design/document-signing.md) — ส่งเข้าคิวแล้ว worker ลงนาม หน้าเว็บถามสถานะซ้ำจนจบ
export const signingRouter = Router();

const createBody = z.object({
  fileId: z.uuid(),
  certificateId: z.uuid(),
  lockDocument: z.boolean(),
  pin: z.string().regex(PIN_PATTERN, 'PIN ต้องเป็นตัวเลข 6–12 หลัก'),
});
const batchParams = z.object({ id: z.uuid() });

// สิทธิ์: document:sign — ส่ง PDF ที่อัปโหลดแล้วเข้าคิวลงนามด้วยใบของตัวเอง (ตรวจ PIN ที่นี่ worker ไม่ได้รับ PIN)
signingRouter.post('/me/signing-batches', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  res.status(202).json({ batch: await createSigningBatch(req.user!, createBody.parse(req.body)) });
});

// สิทธิ์: document:sign — ประวัติการลงนามล่าสุดของตัวเอง
signingRouter.get('/me/signing-batches', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ batches: await listMySigningBatches(req.user!) });
});

// สิทธิ์: document:sign — สถานะของชุดและไฟล์ที่ลงนามแล้ว (ชุดของคนอื่น = 404)
signingRouter.get('/me/signing-batches/:id', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  const { id } = batchParams.parse(req.params);
  res.set('Cache-Control', 'no-store');
  res.json({ batch: await getMySigningBatch(req.user!, id) });
});
