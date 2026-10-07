import type { CookieOptions, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';
import { hasPermission, type AuthUser } from '../services/authorization-service.js';
import type { Permission } from '../services/permissions.js';
import { resolveSession } from '../services/session-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- วิธีมาตรฐานในการเพิ่ม field ให้ Request ของ Express
  namespace Express {
    interface Request {
      /** ผู้ใช้จาก session (ตั้งโดย loadSession) — undefined = ยังไม่ login */
      user?: AuthUser;
      sessionId?: string;
    }
  }
}

function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(config.session.cookieName, token, { ...sessionCookieOptions(), expires: expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.session.cookieName, sessionCookieOptions());
}

// cookie อายุสั้นเก็บ state/nonce/PKCE verifier ระหว่างไป login ที่ Google (CLAUDE.md หัวข้อ 8 ข้อ 2)
// path จำกัดที่ /auth/google จึงส่งเฉพาะตอน callback และ SameSite=Lax ยังส่งได้เพราะ Google redirect กลับแบบ GET
const OAUTH_COOKIE_NAME = `${config.session.cookieName}_oauth`;
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

const oauthCookieSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
});

export type OAuthCookie = z.infer<typeof oauthCookieSchema>;

function oauthCookieOptions(): CookieOptions {
  return { ...sessionCookieOptions(), path: '/auth/google' };
}

export function setOAuthCookie(res: Response, value: OAuthCookie): void {
  // ส่ง object ให้ Express แปลงเป็น JSON cookie (cookie-parser แปลงกลับให้อัตโนมัติ)
  res.cookie(OAUTH_COOKIE_NAME, value, { ...oauthCookieOptions(), maxAge: OAUTH_COOKIE_MAX_AGE_MS });
}

export function clearOAuthCookie(res: Response): void {
  res.clearCookie(OAUTH_COOKIE_NAME, oauthCookieOptions());
}

export function readOAuthCookie(cookies: unknown): OAuthCookie | undefined {
  const parsed = oauthCookieSchema.safeParse((cookies as Record<string, unknown> | undefined)?.[OAUTH_COOKIE_NAME]);
  return parsed.success ? parsed.data : undefined;
}

export function readSessionToken(cookies: unknown): string | undefined {
  const value = (cookies as Record<string, unknown> | undefined)?.[config.session.cookieName];
  return typeof value === 'string' ? value : undefined;
}

/**
 * อ่าน session จาก cookie ทุก request แล้วตั้ง req.user (ไม่บังคับ login)
 * ถ้า cookie ใช้ไม่ได้แล้ว (หมดอายุ/ถูกเพิกถอน) ให้ลบ cookie ทิ้ง
 */
export const loadSession: RequestHandler = async (req, res, next) => {
  const token = readSessionToken(req.cookies);
  if (!token) {
    next();
    return;
  }
  const session = await resolveSession(token);
  if (session) {
    req.user = session.user;
    req.sessionId = session.sessionId;
  } else {
    clearSessionCookie(res);
  }
  next();
};

/** ต้อง login (สถานะบัญชีใดก็ได้ รวมรออนุมัติ) — ใช้กับ endpoint อย่าง /auth/me */
export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
    return;
  }
  next();
};

/** ต้อง login และบัญชีได้รับอนุมัติแล้ว — ค่าเริ่มต้นของ endpoint ที่ "ต้อง login เท่านั้น" */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
    return;
  }
  if (req.user.approvalStatus === 'pending') {
    next(new AppError(403, 'ACCOUNT_PENDING', 'บัญชีของคุณอยู่ระหว่างรอการอนุมัติ'));
    return;
  }
  if (req.user.approvalStatus === 'rejected') {
    next(new AppError(403, 'ACCOUNT_REJECTED', 'บัญชีของคุณไม่ได้รับการอนุมัติ'));
    return;
  }
  next();
};

/** ต้องมี permission ที่ระบุ (รวมการตรวจ requireAuth ไว้แล้ว) */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (!hasPermission(req.user!, permission)) {
        next(new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้'));
        return;
      }
      next();
    });
  };
}
