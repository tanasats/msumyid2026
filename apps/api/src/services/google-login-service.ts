import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import { grantRoleBySystem } from '../repositories/role-repository.js';
import type { AccountType } from '../repositories/session-repository.js';
import { upsertGoogleUser } from '../repositories/user-repository.js';
import { googleOAuth, type GoogleAuthRequest } from './google-oauth.js';
import { createSession } from './session-service.js';

// role ที่ทุกคนได้ตอน login ครั้งแรกและถอนไม่ได้
const BASE_ROLE = 'user';

export type AccountClassification =
  | { accountType: 'student'; facultyCode: string }
  | { accountType: 'staff' }
  | { accountType: 'external' };

/**
 * แยกประเภทบัญชีจาก email และ claim hd (CLAUDE.md หัวข้อ 8 ข้อ 5.1)
 * - โดเมนอยู่ใน ALLOWED_EMAIL_DOMAINS และ hd ตรงกับโดเมน = บัญชี มมส.
 *   - ส่วนหน้า @ เป็นตัวเลข 11 หลักพอดี = นิสิต (คณะ = หลักที่ 5-6)
 *   - นอกนั้น = บุคลากร
 * - นอกนั้น = บุคลากรภายนอก (ต้องรออนุมัติ)
 * ต้องตรวจ hd ด้วย เพราะ email อย่างเดียวไม่ยืนยันว่าบัญชีอยู่ใน Workspace ของมหาวิทยาลัย
 */
export function classifyAccount(
  email: string,
  hd: string | null,
  allowedDomains: readonly string[],
): AccountClassification {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();

  const isInternal = allowedDomains.includes(domain) && hd?.toLowerCase() === domain;
  if (!isInternal) return { accountType: 'external' };

  if (/^[0-9]{11}$/.test(local)) {
    return { accountType: 'student', facultyCode: local.slice(4, 6) };
  }
  return { accountType: 'staff' };
}

/** role ประเภทบัญชีที่ระบบให้ตอน login — external ให้ตอนอนุมัติเท่านั้น (CLAUDE.md หัวข้อ 9) */
function accountRoleOnLogin(accountType: AccountType): string | null {
  return accountType === 'external' ? null : accountType;
}

export async function startGoogleLogin(): Promise<GoogleAuthRequest> {
  return googleOAuth.createAuthRequest();
}

export type GoogleLoginFailure =
  | 'GOOGLE_DENIED'
  | 'INVALID_STATE'
  | 'LOGIN_FAILED'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_DISABLED';

export type GoogleLoginResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: GoogleLoginFailure };

export type GoogleCallbackInput = {
  code?: string;
  state?: string;
  error?: string;
  /** ค่าที่เก็บไว้ใน cookie ตอนเริ่ม login */
  saved?: { state: string; nonce: string; codeVerifier: string };
};

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * จัดการ callback จาก Google: ตรวจ state → แลก code → ตรวจ nonce และ email_verified
 * → สร้าง/อัปเดตผู้ใช้ ให้ role และสร้าง session ใน transaction เดียว
 */
export async function completeGoogleLogin(input: GoogleCallbackInput): Promise<GoogleLoginResult> {
  if (input.error) {
    // ผู้ใช้กดยกเลิกที่หน้า Google หรือ Google ปฏิเสธ
    logger.info({ googleError: input.error }, 'Google login ถูกยกเลิก');
    return { ok: false, reason: 'GOOGLE_DENIED' };
  }
  if (!input.saved || !input.state || !input.code || !safeEqual(input.state, input.saved.state)) {
    logger.warn('Google login: state ไม่ตรงหรือไม่มี cookie');
    return { ok: false, reason: 'INVALID_STATE' };
  }

  let identity;
  try {
    identity = await googleOAuth.exchangeCode(input.code, input.saved.codeVerifier);
  } catch (err) {
    logger.warn({ err }, 'Google login: แลก code หรือตรวจ ID token ไม่ผ่าน');
    return { ok: false, reason: 'LOGIN_FAILED' };
  }

  if (!identity.nonce || !safeEqual(identity.nonce, input.saved.nonce)) {
    logger.warn('Google login: nonce ไม่ตรง');
    return { ok: false, reason: 'LOGIN_FAILED' };
  }
  if (!identity.emailVerified) {
    return { ok: false, reason: 'EMAIL_NOT_VERIFIED' };
  }

  const classification = classifyAccount(identity.email, identity.hd, config.allowedEmailDomains);

  // TODO(ERP-HR): บุคลากรดึงหน่วยงานจาก ERP-HR นอก transaction (ยังไม่ได้สร้าง — CLAUDE.md หัวข้อ 18)
  const result = await withTransaction(async (client) => {
    const user = await upsertGoogleUser(client, {
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name ?? identity.email,
      pictureUrl: identity.picture,
      accountType: classification.accountType,
      orgUnitCode: classification.accountType === 'student' ? classification.facultyCode : null,
      approvalStatus: classification.accountType === 'external' ? 'pending' : 'approved',
    });
    if (!user) return null;

    // ตรวจและให้ role ทุกครั้งที่ login (ให้เฉพาะที่ยังไม่มี) — ใช้ประเภทบัญชีที่บันทึกไว้ ไม่ใช่ค่าจาก client
    const grantedRoles: string[] = [];
    for (const roleCode of [BASE_ROLE, accountRoleOnLogin(user.accountType)]) {
      if (!roleCode) continue;
      const granted = await grantRoleBySystem(client, {
        userId: user.id,
        roleCode,
        reason: 'ระบบให้อัตโนมัติตอนเข้าสู่ระบบด้วย Google',
      });
      if (granted) grantedRoles.push(roleCode);
    }

    const session = await createSession(client, user.id);
    return { user, grantedRoles, session };
  });

  if (!result) {
    // ผู้ใช้ถูกระงับหรือถูกลบ — ไม่สร้าง session
    logger.info('Google login: บัญชีถูกระงับหรือถูกลบ');
    return { ok: false, reason: 'ACCOUNT_DISABLED' };
  }

  const { user, grantedRoles, session } = result;
  if (!user.inserted && user.accountType !== classification.accountType) {
    // ประเภทบัญชีไม่ถูกเปลี่ยนอัตโนมัติ ให้ผู้ดูแลตรวจสอบ
    logger.warn(
      { userId: user.id, stored: user.accountType, detected: classification.accountType },
      'ประเภทบัญชีจาก email ไม่ตรงกับที่บันทึกไว้',
    );
  }
  // ไม่ log email/ชื่อ (ข้อมูลส่วนบุคคล) — ใช้ userId แทน
  logger.info(
    {
      userId: user.id,
      newUser: user.inserted,
      accountType: user.accountType,
      approvalStatus: user.approvalStatus,
      grantedRoles,
    },
    'เข้าสู่ระบบด้วย Google สำเร็จ',
  );

  return { ok: true, token: session.token, expiresAt: session.expiresAt };
}
