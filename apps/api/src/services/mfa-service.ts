import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Queryable } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import { insertUserAuditLog } from '../repositories/admin-user-repository.js';
import {
  confirmMfaTotp,
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  deleteMfaOfUser,
  findMfaTotpStatus,
  lockMfaTotp,
  recordMfaFailure,
  recordMfaSuccess,
  replaceRecoveryCodes,
  upsertPendingMfaTotp,
} from '../repositories/mfa-repository.js';
import { deleteSessionsByUser, markSessionMfaVerified } from '../repositories/session-repository.js';
import { findUsersByEmail } from '../repositories/user-repository.js';
import type { AuthUser } from './authorization-service.js';
import { openTotpSecret, sealTotpSecret } from './mfa-crypto.js';
import { completeMfaLogin, type MfaSessionState } from './session-service.js';
import { base32Encode, generateTotpSecret, totpUri, verifyTotp } from './totp.js';
import { notify } from './user-notification-service.js';

// MFA (docs/design/mfa.md): ปัจจัยที่สองที่ระบบควบคุมเอง ไม่ขึ้นกับบัญชี Google
// - TOTP (แอป Authenticator) 1 ชุดต่อผู้ใช้ + รหัสกู้คืน 10 รหัส (ใช้ได้รหัสละครั้ง)
// - ใส่ผิดครบ 5 ครั้งติดกัน (รวมรหัสกู้คืน) → ล็อก 15 นาที แบบเดียวกับ PIN ลงนาม
// - ทุกการเปลี่ยนแปลงเขียน user_audit_logs และแจ้งเตือนหมวดความปลอดภัย (ปิดไม่ได้) ใน transaction เดียวกัน

export const MFA_ISSUER = 'MSU Digital ID';
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;
/** 10 ไบต์ = 80 บิต = base32 16 ตัว */
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_PATTERN = /^[A-Z2-7]{16}$/;

export type MfaStatus = {
  /** ยืนยันรหัสแรกแล้ว = เปิดใช้งาน */
  enabled: boolean;
  /** เริ่มตั้งค่าแล้วแต่ยังไม่ยืนยัน */
  pending: boolean;
  recoveryCodesRemaining: number;
  lockedUntil: Date | null;
};

export async function getMfaStatus(userId: string): Promise<MfaStatus> {
  const row = await findMfaTotpStatus(pool, userId);
  const enabled = row?.confirmedAt != null;
  return {
    enabled,
    pending: row !== null && !enabled,
    recoveryCodesRemaining: enabled ? await countUnusedRecoveryCodes(pool, userId) : 0,
    lockedUntil: row?.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null,
  };
}

/** รหัสกู้คืนแสดงเป็น XXXX-XXXX-XXXX-XXXX — ตอนตรวจตัดขีด/ช่องว่างและไม่สนตัวพิมพ์ */
function normalizeRecoveryCode(code: string): string | null {
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  return RECOVERY_CODE_PATTERN.test(normalized) ? normalized : null;
}

const hashRecoveryCode = (normalized: string) => createHash('sha256').update(normalized, 'utf8').digest();

function generateRecoveryCodes(): { codes: string[]; hashes: Buffer[] } {
  const raw = Array.from({ length: RECOVERY_CODE_COUNT }, () => base32Encode(randomBytes(RECOVERY_CODE_BYTES)));
  return {
    codes: raw.map((code) => code.match(/.{4}/g)!.join('-')),
    hashes: raw.map(hashRecoveryCode),
  };
}

/**
 * เริ่มตั้งค่า: สุ่ม secret ใหม่ เก็บแบบเข้ารหัส (ยังไม่ยืนยัน) แล้วคืนให้หน้าเว็บสร้าง QR — ครั้งเดียวที่ secret ออกจาก server
 * เปิด MFA อยู่แล้วตั้งใหม่ไม่ได้ (ต้องปิดก่อน) กันผู้ที่ได้ session ไปผูกอุปกรณ์ของตัวเองแทน
 */
export async function startTotpSetup(user: AuthUser): Promise<{ otpauthUri: string; secret: string }> {
  const secret = generateTotpSecret();
  const sealed = sealTotpSecret(user.id, secret);
  const saved = await upsertPendingMfaTotp(pool, { userId: user.id, secretCiphertext: sealed.ciphertext, keyId: sealed.keyId });
  if (!saved) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'บัญชีนี้เปิดการยืนยันตัวตนสองขั้นตอนอยู่แล้ว');
  return { otpauthUri: totpUri({ secret, issuer: MFA_ISSUER, accountName: user.email }), secret: base32Encode(secret) };
}

/**
 * ยืนยันรหัสแรกจากแอป = เปิด MFA แล้วออกรหัสกู้คืน (แสดงครั้งเดียว ระบบเก็บแค่ hash)
 * session ที่ตั้งค่านับว่ายืนยัน MFA แล้ว (เพิ่งพิสูจน์ว่ามีแอปที่ถูกต้อง) — session อื่นของผู้ใช้ต้องยืนยันเอง
 */
export async function confirmTotpSetup(
  user: AuthUser,
  sessionId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  return withTransaction(async (client) => {
    const row = await lockMfaTotp(client, user.id);
    if (!row) throw new AppError(409, 'MFA_SETUP_NOT_STARTED', 'กรุณาเริ่มตั้งค่าใหม่อีกครั้ง');
    if (row.confirmedAt) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'บัญชีนี้เปิดการยืนยันตัวตนสองขั้นตอนอยู่แล้ว');

    const secret = openTotpSecret(user.id, { keyId: row.keyId, ciphertext: row.secretCiphertext });
    const step = verifyTotp(secret, code.trim(), new Date(), null);
    // ระหว่างตั้งค่าไม่นับครั้งที่ผิด (ยังไม่ได้เปิด MFA — ไม่มีอะไรให้เดา) ให้ลองใหม่ได้
    if (step === null) {
      throw new AppError(400, 'MFA_CODE_INCORRECT', 'รหัสไม่ถูกต้อง ตรวจว่าเวลาในโทรศัพท์ตรงกับเวลาจริง แล้วใส่รหัสล่าสุดจากแอป');
    }
    await confirmMfaTotp(client, { userId: user.id, step });
    await markSessionMfaVerified(client, sessionId);
    const { codes, hashes } = generateRecoveryCodes();
    await replaceRecoveryCodes(client, { userId: user.id, codeHashes: hashes });
    await insertUserAuditLog(client, { actorId: user.id, targetUserId: user.id, action: 'mfa_enable', reason: null });
    await notify(client, user.id, { template: 'mfa_enabled', params: {} });
    return { recoveryCodes: codes };
  });
}

export type MfaMethod = 'totp' | 'recovery_code';

type VerifyOutcome =
  | { kind: 'ok'; method: MfaMethod }
  | { kind: 'not_enabled' }
  | { kind: 'locked'; until: Date }
  | { kind: 'wrong'; remaining: number };

/** ตรวจรหัสในคำขอที่ล็อกแถวไว้แล้ว — ผลการนับครั้งที่ผิด/ล็อก/แจ้งเตือนอยู่ใน transaction ของผู้เรียก */
async function checkCode(client: Queryable, userId: string, code: string): Promise<VerifyOutcome> {
  const row = await lockMfaTotp(client, userId);
  if (!row?.confirmedAt) return { kind: 'not_enabled' };
  const now = new Date();
  if (row.lockedUntil && row.lockedUntil > now) return { kind: 'locked', until: row.lockedUntil };

  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const secret = openTotpSecret(userId, { keyId: row.keyId, ciphertext: row.secretCiphertext });
    const step = verifyTotp(secret, trimmed, now, row.lastUsedStep);
    if (step !== null) {
      await recordMfaSuccess(client, { userId, step });
      return { kind: 'ok', method: 'totp' };
    }
  } else {
    const normalized = normalizeRecoveryCode(trimmed);
    if (normalized && (await consumeRecoveryCode(client, { userId, codeHash: hashRecoveryCode(normalized) }))) {
      await recordMfaSuccess(client, { userId, step: null });
      const remaining = await countUnusedRecoveryCodes(client, userId);
      await insertUserAuditLog(client, {
        actorId: userId,
        targetUserId: userId,
        action: 'mfa_recovery_used',
        changes: { remaining },
        reason: null,
      });
      await notify(client, userId, { template: 'mfa_recovery_code_used', params: { remaining } });
      return { kind: 'ok', method: 'recovery_code' };
    }
  }

  const failed = row.failedAttempts + 1;
  if (failed >= MAX_FAILED_ATTEMPTS) {
    const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
    await recordMfaFailure(client, { userId, failedAttempts: 0, lockedUntil: until });
    // ไม่ log รหัสที่ใส่มา
    logger.warn({ userId }, 'ใส่รหัส MFA ผิดครบจำนวนครั้ง ล็อกชั่วคราว');
    await notify(client, userId, { template: 'mfa_locked', params: { lockedUntil: until.toISOString() } });
    return { kind: 'locked', until };
  }
  await recordMfaFailure(client, { userId, failedAttempts: failed, lockedUntil: null });
  return { kind: 'wrong', remaining: MAX_FAILED_ATTEMPTS - failed };
}

function throwUnlessOk(outcome: VerifyOutcome): asserts outcome is { kind: 'ok'; method: MfaMethod } {
  switch (outcome.kind) {
    case 'ok':
      return;
    case 'not_enabled':
      throw new AppError(409, 'MFA_NOT_ENABLED', 'บัญชีนี้ยังไม่ได้เปิดการยืนยันตัวตนสองขั้นตอน');
    case 'locked':
      throw new AppError(
        429,
        'MFA_LOCKED',
        `ใส่รหัสผิดหลายครั้ง กรุณาลองใหม่หลัง ${outcome.until.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' })} น.`,
      );
    case 'wrong':
      throw new AppError(
        403,
        'MFA_CODE_INCORRECT',
        `รหัสไม่ถูกต้อง (ใส่ผิดได้อีก ${outcome.remaining} ครั้งก่อนถูกระงับ ${LOCK_MINUTES} นาที)`,
      );
  }
}

/**
 * ตรวจรหัส MFA (6 หลักจากแอป หรือรหัสกู้คืน) — ใช้ตอนเข้าสู่ระบบและยืนยันซ้ำก่อนทำรายการสำคัญ
 * ทำใน transaction ของตัวเอง: ผลการนับครั้งที่ผิด commit ก่อนแจ้ง error ให้ผู้เรียก (แบบเดียวกับ verifySigningPin)
 */
export async function verifyMfaCode(userId: string, code: string): Promise<MfaMethod> {
  const outcome = await withTransaction((client) => checkCode(client, userId, code));
  throwUnlessOk(outcome);
  return outcome.method;
}

/** ออกรหัสกู้คืนชุดใหม่ (ชุดเดิมใช้ไม่ได้ทันที) — ต้องใส่รหัสปัจจุบัน */
export async function regenerateRecoveryCodes(user: AuthUser, code: string): Promise<{ recoveryCodes: string[] }> {
  await verifyMfaCode(user.id, code);
  return withTransaction(async (client) => {
    const { codes, hashes } = generateRecoveryCodes();
    await replaceRecoveryCodes(client, { userId: user.id, codeHashes: hashes });
    await insertUserAuditLog(client, { actorId: user.id, targetUserId: user.id, action: 'mfa_recovery_regenerate', reason: null });
    await notify(client, user.id, { template: 'mfa_recovery_codes_regenerated', params: {} });
    return { recoveryCodes: codes };
  });
}

/**
 * ปิด MFA ของตัวเอง — ต้องใส่รหัสปัจจุบัน (ผู้ที่ได้ session ไปปิดไม่ได้)
 * ยกเลิกการตั้งค่าที่ยังไม่ยืนยันก็ใช้ทางนี้ได้โดยไม่ต้องใส่รหัส
 */
export async function disableMyMfa(user: AuthUser, mfa: MfaSessionState, code: string | null): Promise<void> {
  const status = await findMfaTotpStatus(pool, user.id);
  if (!status) throw new AppError(409, 'MFA_NOT_ENABLED', 'บัญชีนี้ยังไม่ได้เปิดการยืนยันตัวตนสองขั้นตอน');
  if (status.confirmedAt) {
    // role ที่ถือบังคับ MFA — เปลี่ยนอุปกรณ์ให้ผู้ดูแลรีเซ็ต แล้วตั้งค่าใหม่ตอนเข้าสู่ระบบครั้งถัดไป
    if (mfa.required) {
      throw new AppError(403, 'MFA_REQUIRED_BY_ROLE', 'บทบาทของคุณบังคับใช้การยืนยันตัวตนสองขั้นตอน จึงปิดไม่ได้');
    }
    if (!code) throw new AppError(400, 'MFA_CODE_REQUIRED', 'กรุณาใส่รหัสจากแอป Authenticator หรือรหัสกู้คืน');
    await verifyMfaCode(user.id, code);
  }
  await withTransaction(async (client) => {
    const wasEnabled = await deleteMfaOfUser(client, user.id);
    if (!wasEnabled) return;
    await insertUserAuditLog(client, { actorId: user.id, targetUserId: user.id, action: 'mfa_disable', reason: null });
    await notify(client, user.id, { template: 'mfa_disabled', params: {} });
  });
}

/**
 * ยืนยัน MFA ตอนเข้าสู่ระบบ (หลังผ่าน Google แล้ว) — รหัสถูกแล้วออก token ใหม่ให้ session (กัน session fixation)
 * คืน token ใหม่ให้ route ตั้ง cookie
 */
export async function verifyMfaLogin(
  user: AuthUser,
  sessionId: string,
  mfa: MfaSessionState,
  code: string,
): Promise<{ token: string; expiresAt: Date; method: MfaMethod }> {
  if (!mfa.enabled) throw new AppError(409, 'MFA_NOT_ENABLED', 'บัญชีนี้ยังไม่ได้เปิดการยืนยันตัวตนสองขั้นตอน');
  const method = await verifyMfaCode(user.id, code);
  const session = await completeMfaLogin(sessionId);
  if (!session) throw new AppError(401, 'UNAUTHENTICATED', 'session หมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่');
  logger.info({ userId: user.id, method }, 'ยืนยัน MFA ตอนเข้าสู่ระบบ');
  return { ...session, method };
}

/** ยืนยันซ้ำก่อนทำรายการสำคัญ — รหัสถูกแล้วนับเวลาใหม่ให้ session นี้ */
export async function stepUpMfa(user: AuthUser, sessionId: string, code: string): Promise<void> {
  await verifyMfaCode(user.id, code);
  await markSessionMfaVerified(pool, sessionId);
}

/**
 * รีเซ็ต MFA ของผู้ใช้ที่ทำโทรศัพท์หาย/ไม่มีรหัสกู้คืน — เรียกใน transaction ของผู้เรียก (ผู้เรียกตรวจสิทธิ์และล็อกผู้ใช้แล้ว)
 * ลบ secret + รหัสกู้คืน, ออกจากระบบทุกอุปกรณ์ (อุปกรณ์อาจอยู่ในมือผู้อื่น), audit mfa_reset, แจ้งเจ้าของบัญชี
 * actorId = null คือสคริปต์ mfa:reset บนเซิร์ฟเวอร์ (super_admin คนสุดท้ายเข้าระบบไม่ได้)
 */
export async function resetMfaOfUser(
  client: Queryable,
  input: { actorId: string | null; userId: string; reason: string },
): Promise<{ revokedSessions: number }> {
  const wasEnabled = await deleteMfaOfUser(client, input.userId);
  if (!wasEnabled) throw new AppError(409, 'MFA_NOT_ENABLED', 'บัญชีนี้ยังไม่ได้เปิดการยืนยันตัวตนสองขั้นตอน');
  const revokedSessions = await deleteSessionsByUser(client, input.userId);
  await insertUserAuditLog(client, {
    actorId: input.actorId,
    targetUserId: input.userId,
    action: 'mfa_reset',
    changes: { revokedSessions },
    reason: input.reason,
  });
  await notify(client, input.userId, { template: 'mfa_reset_by_admin', params: { reason: input.reason } });
  logger.info({ userId: input.userId, actorId: input.actorId }, 'รีเซ็ต MFA ของผู้ใช้');
  return { revokedSessions };
}

export type CliMfaResetResult =
  | { ok: true; userId: string; revokedSessions: number }
  | { ok: false; reason: 'USER_NOT_FOUND' | 'AMBIGUOUS_EMAIL' | 'MFA_NOT_ENABLED' };

/**
 * ทางออกฉุกเฉินจากสคริปต์ mfa:reset บนเซิร์ฟเวอร์ (ไม่มีทาง API) — เช่น super_admin คนสุดท้ายทำโทรศัพท์หาย
 * audit actor = NULL (ระบบ) ผู้ที่เข้าถึงเซิร์ฟเวอร์ได้ถือว่ามีสิทธิ์สูงสุดอยู่แล้ว
 */
export async function resetMfaByEmail(email: string, reason: string): Promise<CliMfaResetResult> {
  return withTransaction(async (client) => {
    const users = await findUsersByEmail(client, email);
    if (users.length === 0) return { ok: false, reason: 'USER_NOT_FOUND' };
    if (users.length > 1) return { ok: false, reason: 'AMBIGUOUS_EMAIL' };
    const userId = users[0]!.id;
    const status = await findMfaTotpStatus(client, userId);
    if (!status?.confirmedAt) return { ok: false, reason: 'MFA_NOT_ENABLED' };
    const { revokedSessions } = await resetMfaOfUser(client, { actorId: null, userId, reason });
    return { ok: true, userId, revokedSessions };
  });
}
