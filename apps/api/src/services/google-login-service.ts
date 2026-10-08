import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import { grantRoleBySystem } from '../repositories/role-repository.js';
import type { AccountType } from '../repositories/session-repository.js';
import { upsertErpOrgUnit } from '../repositories/erp-org-unit-repository.js';
import { upsertStaffProfile } from '../repositories/staff-profile-repository.js';
import { insertUserAuditLog } from '../repositories/admin-user-repository.js';
import { linkPreRegisteredUser, syncStaffOrgUnit, upsertGoogleUser } from '../repositories/user-repository.js';
import { erpHr, type ErpStaffInfo } from './erp-hr.js';
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

/** role ประเภทบัญชีที่ระบบให้ตอน login — external/service ให้ตอนอนุมัติเท่านั้น (CLAUDE.md หัวข้อ 9) */
function accountRoleOnLogin(accountType: AccountType): string | null {
  return accountType === 'external' || accountType === 'service' ? null : accountType;
}

/**
 * ผลการเรียก ERP-HR — แยก "ไม่พบบุคลากร" ออกจาก "เรียกไม่สำเร็จ"
 * เพราะ not_found ใช้ตัดสินว่าบัญชีใหม่เป็นบัญชีหน่วยงาน ส่วน failed (ERP ล่ม) ต้องไม่ทำให้ใครเสียสิทธิ์
 */
export type StaffInfoResult =
  | { status: 'found'; info: ErpStaffInfo }
  | { status: 'not_found' }
  | { status: 'failed' };

/**
 * เรียก ERP-HR โดยไม่ให้ error หลุดออกไปทำให้ login ล้ม
 * log เฉพาะประเภท error — ห้าม log access token หรือข้อมูลบุคลากร (CLAUDE.md หัวข้อ 13, 18)
 */
async function fetchStaffInfoSafely(accessToken: string): Promise<StaffInfoResult> {
  try {
    const info = await erpHr.fetchStaffInfo(accessToken);
    if (!info) {
      logger.info('ERP-HR ไม่พบข้อมูลบุคลากรของบัญชีนี้');
      return { status: 'not_found' };
    }
    return { status: 'found', info };
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown';
    logger.warn({ reason }, 'เรียก ERP-HR ไม่สำเร็จ ใช้ข้อมูลบุคลากรเดิม');
    return { status: 'failed' };
  }
}

/**
 * ประเภทบัญชีและสถานะอนุมัติ "สำหรับผู้ใช้ใหม่" (ผู้ใช้เดิมไม่ถูกเปลี่ยน — upsertGoogleUser ใช้ค่านี้ตอน INSERT เท่านั้น)
 * - บุคลากรภายนอก → รออนุมัติ
 * - บัญชี มมส. ที่ไม่ใช่นิสิต และ ERP ยืนยันว่าไม่พบบุคลากร → บัญชีหน่วยงาน รออนุมัติ
 *   (บัญชีที่ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม — ผู้มี user:approve กำหนดหน่วยงานและผู้รับผิดชอบก่อนอนุมัติ)
 * - ERP เรียกไม่สำเร็จ → ยังเป็นบุคลากร (ERP ล่มต้องไม่ทำให้บุคลากรใช้งานไม่ได้ — CLAUDE.md หัวข้อ 18)
 */
export function newAccountStatus(
  classification: AccountClassification,
  staffInfo: StaffInfoResult | null,
): { accountType: AccountType; approvalStatus: 'pending' | 'approved' } {
  if (classification.accountType === 'external') return { accountType: 'external', approvalStatus: 'pending' };
  if (classification.accountType === 'staff' && staffInfo?.status === 'not_found') {
    return { accountType: 'service', approvalStatus: 'pending' };
  }
  return { accountType: classification.accountType, approvalStatus: 'approved' };
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

  // บุคลากร: ดึงข้อมูลจาก ERP-HR "นอก transaction" (ไม่ถือ connection ไว้ระหว่างรอ ERP)
  // ล้มเหลว = null แล้ว login ต่อได้ตามปกติ (CLAUDE.md หัวข้อ 18)
  const staffResult =
    classification.accountType === 'staff' && identity.accessToken
      ? await fetchStaffInfoSafely(identity.accessToken)
      : null;
  const staffInfo = staffResult?.status === 'found' ? staffResult.info : null;
  const newAccount = newAccountStatus(classification, staffResult);

  // บัญชีที่ผู้ดูแลลงทะเบียนล่วงหน้า: ผูกได้เมื่ออีเมลยืนยันแล้ว (ตรวจข้างบน) และอีเมลโดเมน มมส. ต้องมี hd ตรง
  // (classifyAccount ให้ external เมื่อโดเมน มมส. ไม่มี hd = บัญชี Google ส่วนตัวที่ใช้อีเมล มมส. ห้ามสวมสิทธิ์)
  const emailDomain = identity.email.slice(identity.email.lastIndexOf('@') + 1).toLowerCase();
  const canLinkPreRegistered =
    !config.allowedEmailDomains.includes(emailDomain) || classification.accountType !== 'external';

  const result = await withTransaction(async (client) => {
    // ไม่พบ google_sub นี้ แต่มีบัญชีลงทะเบียนล่วงหน้าด้วยอีเมลนี้ → ผูก google_sub ก่อน
    // แล้ว upsert ด้านล่างจะเข้าทาง "ผู้ใช้เดิม" (คงประเภทบัญชี/สถานะอนุมัติที่ผู้ดูแลกำหนด)
    const linkedUserId = canLinkPreRegistered
      ? await linkPreRegisteredUser(client, { googleSub: identity.sub, email: identity.email })
      : null;
    if (linkedUserId) {
      await insertUserAuditLog(client, {
        actorId: null,
        targetUserId: linkedUserId,
        action: 'link_google',
        reason: 'ผูกบัญชี Google ตอนเข้าสู่ระบบครั้งแรก',
      });
    }

    const user = await upsertGoogleUser(client, {
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name ?? identity.email,
      erpDisplayName: staffInfo ? `${staffInfo.firstNameTh} ${staffInfo.lastNameTh}` : null,
      pictureUrl: identity.picture,
      accountType: newAccount.accountType,
      orgUnitCode: classification.accountType === 'student' ? classification.facultyCode : null,
      approvalStatus: newAccount.approvalStatus,
    });
    if (!user) return null;

    if (user.accountType === 'staff') {
      if (staffInfo) {
        // ต้องบันทึกหน่วยงาน ERP ก่อน เพราะ staff_profiles อ้างถึงด้วยรหัส ERP
        if (staffInfo.faculty) {
          await upsertErpOrgUnit(client, { ...staffInfo.faculty, level: 'faculty' });
        }
        if (staffInfo.department) {
          await upsertErpOrgUnit(client, { ...staffInfo.department, level: 'department' });
        }
        await upsertStaffProfile(client, user.id, staffInfo);
      }
      // คำนวณหน่วยงานใหม่ทุกครั้ง (รวมกรณี ERP ล่มแต่ผู้ดูแลเพิ่งแก้การจับคู่)
      await syncStaffOrgUnit(client, user.id);
    }

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
    return { user, grantedRoles, session, linked: linkedUserId !== null };
  });

  if (!result) {
    // ผู้ใช้ถูกระงับ ถูกลบ หรือบัญชีหมดอายุ — ไม่สร้าง session
    logger.info('Google login: บัญชีถูกระงับ ถูกลบ หรือหมดอายุ');
    return { ok: false, reason: 'ACCOUNT_DISABLED' };
  }

  const { user, grantedRoles, session, linked } = result;
  // บัญชีหน่วยงานใช้อีเมล มมส. ที่ไม่ใช่นิสิต จึงตรวจพบเป็น staff เสมอ — ไม่ถือว่าไม่ตรง
  const matchesDetected =
    user.accountType === classification.accountType ||
    (user.accountType === 'service' && classification.accountType === 'staff');
  if (!user.inserted && !matchesDetected) {
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
      erpSynced: staffInfo !== null,
      linkedPreRegistered: linked,
    },
    'เข้าสู่ระบบด้วย Google สำเร็จ',
  );

  return { ok: true, token: session.token, expiresAt: session.expiresAt };
}
