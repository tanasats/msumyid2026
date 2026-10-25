import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import { PIN_PATTERN } from '../services/signing-pin-service.js';
import { createSigningBatch, getMySigningBatch, listMySigningBatches } from '../services/signing-service.js';

// ลงนามเอกสารบนเว็บ (docs/design/document-signing.md) — ส่งเข้าคิวแล้ว worker ลงนาม หน้าเว็บถามสถานะซ้ำจนจบ
export const signingRouter = Router();

// ตำแหน่งเป็นสัดส่วนของหน้าที่แสดงผล (มุมซ้ายบน) กล่องต้องอยู่ในหน้าทั้งหมด และกว้าง/สูงอย่างน้อย 2% ของหน้า
// ค่าคลาดเล็กน้อยจากการปัดเศษของ browser (1e-6) ยอมรับได้
const fraction = z.number().min(0).max(1);
const visibleAppearance = z
  .object({
    visible: z.literal(true),
    page: z.number().int().min(1).max(10_000),
    x: fraction,
    y: fraction,
    w: z.number().min(0.02).max(1),
    h: z.number().min(0.02).max(1),
    showText: z.boolean(),
    useImage: z.boolean(),
  })
  .refine((a) => a.x + a.w <= 1 + 1e-6 && a.y + a.h <= 1 + 1e-6, 'กรอบลายเซ็นต้องอยู่ภายในหน้าเอกสาร');
const appearance = z.discriminatedUnion('visible', [z.object({ visible: z.literal(false) }), visibleAppearance]);

const createBody = z.object({
  fileId: z.uuid(),
  certificateId: z.uuid(),
  lockDocument: z.boolean(),
  // ไม่ส่ง = มองไม่เห็น (แบบ D1)
  appearance: appearance.default({ visible: false }),
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
