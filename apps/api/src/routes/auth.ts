import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  clearOAuthCookie,
  clearSessionCookie,
  readOAuthCookie,
  readSessionToken,
  requireSession,
  setOAuthCookie,
  setSessionCookie,
} from '../middlewares/auth.js';
import { getCurrentUser } from '../services/auth-service.js';
import {
  completeGoogleLogin,
  startGoogleLogin,
  type GoogleLoginResult,
} from '../services/google-login-service.js';
import { revokeSession } from '../services/session-service.js';

export const authRouter = Router();

// จำกัดจำนวนครั้งต่อ IP เฉพาะขั้นตอนเข้าสู่ระบบ (/auth/google และ /auth/google/callback)
// ไม่จำกัด /auth/me และ /auth/logout: หน้าเว็บเรียก /auth/me จาก Next.js server ทุกครั้งที่เปิดหน้า
// API จึงเห็นทุกคำขอมาจาก IP เดียวกัน ถ้าจำกัดไว้ ผู้ใช้ทั้งระบบจะใช้โควตาร่วมกันและถูกบล็อกพร้อมกัน
authRouter.use(
  '/auth/google',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'TOO_MANY_REQUESTS', message: 'มีการเรียกใช้งานถี่เกินไป กรุณาลองใหม่ภายหลัง' },
      });
    },
  }),
);

// สิทธิ์: public — เริ่ม login ด้วย Google (redirect ไปหน้า Google)
authRouter.get('/auth/google', async (_req, res) => {
  const { url, state, nonce, codeVerifier } = await startGoogleLogin();
  setOAuthCookie(res, { state, nonce, codeVerifier });
  res.redirect(url);
});

// Google ส่งค่ามาทาง query — ค่าที่ไม่ใช่ string ถือว่าไม่มี
const callbackQuerySchema = z.object({
  code: z.string().optional().catch(undefined),
  state: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
});

// สิทธิ์: public — Google เรียกกลับหลัง login
// เป็นการเปิดหน้าใน browser จึงตอบด้วย redirect กลับ web เสมอ (ไม่ตอบ JSON)
authRouter.get('/auth/google/callback', async (req, res) => {
  const query = callbackQuerySchema.parse(req.query);
  const saved = readOAuthCookie(req.cookies);
  clearOAuthCookie(res);

  let result: GoogleLoginResult;
  try {
    result = await completeGoogleLogin({ ...query, saved });
  } catch (err) {
    // error ที่ไม่คาดคิด (เช่น ฐานข้อมูลล่ม) — log แล้วพาผู้ใช้กลับหน้า login พร้อมข้อความ
    req.log.error({ err }, 'Google login ล้มเหลว');
    result = { ok: false, reason: 'LOGIN_FAILED' };
  }

  if (!result.ok) {
    res.redirect(`${config.webUrl}/login?error=${result.reason}`);
    return;
  }
  setSessionCookie(res, result.token, result.expiresAt);
  res.redirect(config.webUrl);
});

// สิทธิ์: ต้อง login (รวมบัญชีรออนุมัติ เพื่อให้ web แสดงหน้ารออนุมัติได้)
authRouter.get('/auth/me', requireSession, async (req, res) => {
  const user = await getCurrentUser(req.user!);
  res.json({ user });
});

// สิทธิ์: public — ออกจากระบบได้เสมอแม้ session หมดอายุแล้ว (CSRF ตรวจโดย csrfProtection)
authRouter.post('/auth/logout', async (req, res) => {
  const token = readSessionToken(req.cookies);
  if (token) await revokeSession(token);
  clearSessionCookie(res);
  res.status(204).end();
});
