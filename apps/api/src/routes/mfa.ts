import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, requireAuthForMfaSetup, requireSession, setSessionCookie } from '../middlewares/auth.js';
import {
  confirmTotpSetup,
  disableMyMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
  startTotpSetup,
  stepUpMfa,
  verifyMfaLogin,
} from '../services/mfa-service.js';

// MFA (docs/design/mfa.md)
export const mfaRouter = Router();

// รหัส 6 หลักจากแอป หรือรหัสกู้คืน (XXXX-XXXX-XXXX-XXXX) — ตรวจรูปแบบจริงใน service
const code = z.string().trim().min(6).max(32);
const codeBody = z.object({ code });
const disableBody = z.object({ code: code.optional().transform((v) => v ?? null) });

// จำกัดจำนวนครั้งต่อ IP ที่ endpoint ตรวจรหัส (ต่อผู้ใช้มีล็อก 5 ครั้ง/15 นาทีใน service อยู่แล้ว)
// browser เรียกตรง (ไม่ผ่าน Next.js server) IP จึงเป็นของผู้ใช้แต่ละคน
const codeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'ส่งรหัสบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' } });
  },
});

// --- เข้าสู่ระบบ / ยืนยันซ้ำ ---

// สิทธิ์: ต้อง login (session ที่ยังไม่ยืนยัน MFA) — ใส่รหัสหลังผ่าน Google แล้วได้ token ใหม่
mfaRouter.post('/auth/mfa/verify', codeRateLimit, requireSession, async (req, res) => {
  const { code } = codeBody.parse(req.body);
  const result = await verifyMfaLogin(req.user!, req.sessionId!, req.mfa!, code);
  setSessionCookie(res, result.token, result.expiresAt);
  res.json({ method: result.method });
});

// สิทธิ์: ต้อง login เท่านั้น — ยืนยันซ้ำก่อนทำรายการสำคัญ
mfaRouter.post('/auth/mfa/step-up', codeRateLimit, requireAuth, async (req, res) => {
  const { code } = codeBody.parse(req.body);
  await stepUpMfa(req.user!, req.sessionId!, code);
  res.status(204).end();
});

// --- จัดการ MFA ของตัวเอง ---
// สิทธิ์: ต้อง login เท่านั้น (ไม่ต้องมี permission) — จัดการได้เฉพาะของตัวเอง
// ดูสถานะ/ตั้งค่า ใช้ requireAuthForMfaSetup: ผู้ที่ role บังคับ MFA และยังไม่ได้ตั้งค่า ต้องเข้ามาตั้งค่าได้

mfaRouter.get('/me/mfa', requireAuthForMfaSetup, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ...(await getMfaStatus(req.user!.id)), required: req.mfa!.required });
});

// เริ่มตั้งค่า — คืน secret (ครั้งเดียว) ให้หน้าเว็บสร้าง QR
mfaRouter.post('/me/mfa/totp/setup', requireAuthForMfaSetup, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await startTotpSetup(req.user!));
});

// ยืนยันรหัสแรก = เปิด MFA — คืนรหัสกู้คืน (แสดงครั้งเดียว)
mfaRouter.post('/me/mfa/totp/confirm', codeRateLimit, requireAuthForMfaSetup, async (req, res) => {
  const { code } = codeBody.parse(req.body);
  res.set('Cache-Control', 'no-store');
  res.json(await confirmTotpSetup(req.user!, req.sessionId!, code));
});

// ออกรหัสกู้คืนชุดใหม่ — ต้องใส่รหัสปัจจุบัน
mfaRouter.post('/me/mfa/recovery-codes', codeRateLimit, requireAuth, async (req, res) => {
  const { code } = codeBody.parse(req.body);
  res.set('Cache-Control', 'no-store');
  res.json(await regenerateRecoveryCodes(req.user!, code));
});

// ปิด MFA — ต้องใส่รหัสปัจจุบัน (ยกเลิกการตั้งค่าที่ยังไม่ยืนยันไม่ต้องใส่) / role บังคับ = ปิดไม่ได้
mfaRouter.delete('/me/mfa', codeRateLimit, requireAuthForMfaSetup, async (req, res) => {
  const { code } = disableBody.parse(req.body ?? {});
  await disableMyMfa(req.user!, req.mfa!, code);
  res.status(204).end();
});
