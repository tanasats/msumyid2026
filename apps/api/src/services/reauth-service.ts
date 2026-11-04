import { pool } from '../db/pool.js';
import type { Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import { findSessionCreatedAt } from '../repositories/session-repository.js';
import type { MfaSessionState } from './session-service.js';
import { readSystemSettings } from './system-settings-service.js';

// ยืนยันตัวตนซ้ำ (step-up) ก่อนทำรายการสำคัญ (docs/design/mfa.md) — กันผู้ที่ได้ session ไป (cookie หลุด, เครื่องที่ลืม logout)
// - ผู้ที่เปิด MFA: ต้องใส่รหัส (ตอน login หรือ POST /auth/mfa/step-up) ภายใน 10 นาทีที่ผ่านมา → MFA_STEP_UP_REQUIRED
// - ผู้ที่ไม่เปิด MFA: ต้อง login ภายใน 10 นาทีที่ผ่านมา (กฎเดิมของการตั้ง PIN ลงนามใหม่) → RECENT_LOGIN_REQUIRED
// super_admin เปิด/ปิดรายกลุ่มที่ /admin/settings (system_settings.mfa_step_up_actions)

export const STEP_UP_WINDOW_MINUTES = 10;

/** กลุ่มที่ super_admin เปิด/ปิดได้ — ตรงกับ CHECK ของ system_settings.mfa_step_up_actions */
export const MFA_STEP_UP_ACTIONS = ['certificate', 'role', 'system_settings', 'user_admin'] as const;
export type StepUpAction = (typeof MFA_STEP_UP_ACTIONS)[number];

export type ReauthContext = { sessionId: string; mfa: MfaSessionState };

const withinWindow = (at: Date | null, now: Date) =>
  at !== null && now.getTime() - at.getTime() <= STEP_UP_WINDOW_MINUTES * 60_000;

/** กลุ่มนี้ต้องยืนยันซ้ำหรือไม่ (อ่านค่าตั้งทุกครั้ง แก้แล้วมีผลทันที) */
export async function isStepUpEnabled(action: StepUpAction, db: Queryable = pool): Promise<boolean> {
  return (await readSystemSettings(db)).mfaStepUpActions.includes(action);
}

/**
 * ตรวจว่า session นี้เพิ่งยืนยันตัวตน — ไม่ผ่านแล้ว throw ให้หน้าเว็บขอรหัส (หรือให้ login ใหม่) แล้วส่งคำขอเดิมซ้ำ
 * ใช้ตรงเมื่อรายการนั้นต้องยืนยันซ้ำเสมอ (ไม่ขึ้นกับสวิตช์) ส่วนรายการทั่วไปใช้ assertStepUp
 */
export async function assertRecentAuth(ctx: ReauthContext, now = new Date()): Promise<void> {
  if (ctx.mfa.enabled) {
    if (withinWindow(ctx.mfa.verifiedAt, now)) return;
    throw new AppError(
      403,
      'MFA_STEP_UP_REQUIRED',
      `รายการนี้ต้องยืนยันตัวตนอีกครั้ง — ใส่รหัสจากแอป Authenticator (มีผล ${STEP_UP_WINDOW_MINUTES} นาที)`,
    );
  }
  if (withinWindow(await findSessionCreatedAt(pool, ctx.sessionId), now)) return;
  throw new AppError(
    403,
    'RECENT_LOGIN_REQUIRED',
    `รายการนี้ต้องยืนยันตัวตนอีกครั้ง — ออกจากระบบแล้วเข้าสู่ระบบใหม่ แล้วทำรายการภายใน ${STEP_UP_WINDOW_MINUTES} นาที`,
  );
}

/** ยืนยันซ้ำเฉพาะเมื่อกลุ่มนี้เปิดอยู่ */
export async function assertStepUp(ctx: ReauthContext, action: StepUpAction): Promise<void> {
  if (await isStepUpEnabled(action)) await assertRecentAuth(ctx);
}
