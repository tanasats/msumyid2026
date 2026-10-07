import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { clearSessionCookie, readSessionToken, requireSession } from '../middlewares/auth.js';
import { getCurrentUser } from '../services/auth-service.js';
import { revokeSession } from '../services/session-service.js';

export const authRouter = Router();

// จำกัดจำนวนครั้งต่อ IP สำหรับ /auth/* (CLAUDE.md หัวข้อ 7)
authRouter.use(
  '/auth',
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
