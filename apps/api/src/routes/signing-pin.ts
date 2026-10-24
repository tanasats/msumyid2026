import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import { getSigningPinStatus, PIN_PATTERN, setSigningPin } from '../services/signing-pin-service.js';

// PIN ลงนามเอกสาร (docs/design/document-signing.md)
export const signingPinRouter = Router();

const pin = z.string().regex(PIN_PATTERN, 'PIN ต้องเป็นตัวเลข 6–12 หลัก');
const setBody = z.object({ currentPin: pin.optional().transform((v) => v ?? null), newPin: pin });

// สิทธิ์: ต้อง login เท่านั้น — ตั้ง PIN แล้วหรือยัง / ถูกล็อกถึงเมื่อไร (ไม่คืน hash)
signingPinRouter.get('/me/signing-pin', requireAuth, async (req, res) => {
  res.json(await getSigningPinStatus(req.user!));
});

// สิทธิ์: document:sign — ตั้ง/เปลี่ยน PIN (เปลี่ยนต้องใส่ PIN เดิม หรือเพิ่ง login ภายใน 10 นาที)
signingPinRouter.put('/me/signing-pin', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  await setSigningPin(req.user!, req.sessionId!, setBody.parse(req.body));
  res.json(await getSigningPinStatus(req.user!));
});
