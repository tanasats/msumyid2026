import type { CookieOptions, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';
import { hasPermission, type AuthUser } from '../services/authorization-service.js';
import type { Permission } from '../services/permissions.js';
import { assertStepUp, type StepUpAction } from '../services/reauth-service.js';
import { resolveSession, type MfaSessionState } from '../services/session-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- วิธีมาตรฐานในการเพิ่ม field ให้ Request ของ Express
  namespace Express {
    interface Request {
      /** ผู้ใช้จาก session (ตั้งโดย loadSession) — undefined = ยังไม่ login */
      user?: AuthUser;
      sessionId?: string;
      /** สถานะ MFA ของ session (ตั้งพร้อม user) */
      mfa?: MfaSessionState;
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
// path จำกัดที่โฟลเดอร์ของ callback (dev: /auth/google, production: /api/auth/google — config.google.oauthCookiePath)
// จึงส่งเฉพาะตอน callback และ SameSite=Lax ยังส่งได้เพราะ Google redirect กลับแบบ GET
const OAUTH_COOKIE_NAME = `${config.session.cookieName}_oauth`;
const OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

const oauthCookieSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  codeVerifier: z.string().min(1),
});

export type OAuthCookie = z.infer<typeof oauthCookieSchema>;

function oauthCookieOptions(): CookieOptions {
  return { ...sessionCookieOptions(), path: config.google.oauthCookiePath };
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
    req.mfa = session.mfa;
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

const mfaRequiredError = () =>
  new AppError(403, 'MFA_REQUIRED', 'กรุณายืนยันตัวตนด้วยรหัสจากแอป Authenticator ก่อนใช้งาน');

/** session ที่ผู้ใช้เปิด MFA แต่ยังไม่ได้ใส่รหัส */
const mfaPending = (mfa: MfaSessionState | undefined) => mfa?.enabled === true && mfa.verifiedAt === null;

/**
 * ต้อง login และผ่าน MFA ของ session นี้แล้ว (ถ้าเปิดไว้) แต่สถานะบัญชีใดก็ได้
 * ใช้กับ endpoint ที่ต้องเรียกได้ก่อนรับทราบประกาศ/ก่อนอนุมัติ เช่น กดรับทราบประกาศความเป็นส่วนตัว
 */
export const requireMfaPassed: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(new AppError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
    return;
  }
  next(mfaPending(req.mfa) ? mfaRequiredError() : undefined);
};

/**
 * ตรวจตามลำดับ (docs/design/mfa.md):
 * 1. login แล้ว
 * 2. ผ่าน MFA ของ session นี้ (ถ้าเปิดไว้) — ก่อนทุกอย่าง เพราะผู้ที่ได้ session ไปยังไม่ได้พิสูจน์ปัจจัยที่สอง
 * 3. รับทราบประกาศความเป็นส่วนตัว (ยืนยัน 2026-10-26) — ก่อนตั้งค่า MFA เพราะการตั้งค่าคือการเก็บข้อมูลยืนยันตัวตนใหม่
 * 4. ตั้งค่า MFA แล้วถ้า role ที่ถือบังคับ (ข้ามได้เฉพาะ endpoint ตั้งค่า MFA เอง)
 * 5. บัญชีได้รับอนุมัติแล้ว
 */
function checkAuth(options: { allowMfaEnrollment: boolean }): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new AppError(401, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ'));
      return;
    }
    if (mfaPending(req.mfa)) {
      next(mfaRequiredError());
      return;
    }
    if (!req.user.privacyAcknowledged) {
      next(new AppError(403, 'PRIVACY_NOTICE_REQUIRED', 'กรุณาอ่านและรับทราบประกาศความเป็นส่วนตัวก่อนใช้งาน'));
      return;
    }
    if (!options.allowMfaEnrollment && req.mfa?.required && !req.mfa.enabled) {
      next(
        new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'บัญชีของคุณต้องตั้งค่าการยืนยันตัวตนสองขั้นตอนก่อนใช้งาน'),
      );
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
}

/**
 * ต้อง login, ผ่าน MFA (ถ้าเปิด/บังคับ), รับทราบประกาศความเป็นส่วนตัวเวอร์ชันปัจจุบัน และบัญชีได้รับอนุมัติแล้ว
 * — ค่าเริ่มต้นของ endpoint ที่ "ต้อง login เท่านั้น"
 */
export const requireAuth: RequestHandler = checkAuth({ allowMfaEnrollment: false });

/** เหมือน requireAuth แต่ยอมให้ผู้ที่ role บังคับ MFA และยังไม่ได้ตั้งค่า — ใช้กับ endpoint ตั้งค่า MFA เท่านั้น */
export const requireAuthForMfaSetup: RequestHandler = checkAuth({ allowMfaEnrollment: true });

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

/**
 * ต้องยืนยันตัวตนซ้ำภายใน 10 นาที ถ้า super_admin เปิดกลุ่มนี้ไว้ (reauth-service) — วางต่อจาก requireAuth/requirePermission
 * หน้าเว็บจับ MFA_STEP_UP_REQUIRED / RECENT_LOGIN_REQUIRED แล้วขอรหัส (StepUpDialog) ก่อนส่งคำขอเดิมซ้ำ
 */
export function requireStepUp(action: StepUpAction): RequestHandler {
  return async (req, _res, next) => {
    await assertStepUp({ sessionId: req.sessionId!, mfa: req.mfa! }, action);
    next();
  };
}
