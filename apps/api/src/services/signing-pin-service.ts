import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { findSessionCreatedAt } from '../repositories/session-repository.js';
import {
  findSigningPin,
  lockSigningPin,
  recordPinFailure,
  resetPinFailures,
  upsertSigningPin,
} from '../repositories/signing-pin-repository.js';
import type { AuthUser } from './authorization-service.js';

// PIN ลงนามเอกสาร (ยืนยัน 2026-10-25) — ยืนยันตัวก่อน server ลงนามด้วย key สำรอง (docs/design/document-signing.md)
// - เก็บเฉพาะ scrypt hash + salt ต่อผู้ใช้ (ไม่ต้องเพิ่ม dependency)
// - ใส่ผิดครบ 5 ครั้งติดกัน → ล็อก 15 นาที
// - เปลี่ยน PIN ต้องใส่ PIN เดิม หรือเพิ่ง login ภายใน 10 นาที (ลืม PIN → login ใหม่แล้วตั้งใหม่)

export const PIN_PATTERN = /^\d{6,12}$/;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RECENT_LOGIN_MINUTES = 10;
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 } as const;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** scrypt$N$r$p$<salt>$<hash> — เก็บค่าความยากไว้ในตัว เปลี่ยนค่าภายหลังได้โดย hash เดิมยังตรวจได้ */
async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function pinMatches(pin: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pin, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

/** PIN ที่เดาง่าย: เลขเดียวกันทั้งหมด หรือเรียงขึ้น/ลงติดกัน (123456, 987654) */
function isWeakPin(pin: string): boolean {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  return Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1]! === step);
}

export type SigningPinStatus = { hasPin: boolean; lockedUntil: Date | null };

/** สถานะ PIN ของผู้ใช้ (หน้าเว็บใช้บอกว่าต้องตั้ง PIN หรือถูกล็อกถึงเมื่อไร) */
export async function getSigningPinStatus(user: AuthUser): Promise<SigningPinStatus> {
  const pin = await findSigningPin(pool, user.id);
  const locked = pin?.lockedUntil && pin.lockedUntil > new Date() ? pin.lockedUntil : null;
  return { hasPin: pin !== null, lockedUntil: locked };
}

const lockedError = (until: Date) =>
  new AppError(
    429,
    'PIN_LOCKED',
    `ใส่ PIN ผิดหลายครั้ง กรุณาลองใหม่หลัง ${until.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' })} น.`,
  );

/**
 * ตรวจ PIN — ผิดแล้วนับครั้ง (บันทึกแม้ throw) ครบ 5 ครั้งล็อก 15 นาที ถูกแล้วล้างจำนวนครั้ง
 * ทำใน transaction ของตัวเองที่ล็อกแถว PIN ไว้ ผลการนับจึง commit ก่อนแจ้ง error ให้ผู้เรียก
 */
export async function verifySigningPin(userId: string, pin: string): Promise<void> {
  const outcome = await withTransaction(async (client) => {
    const row = await lockSigningPin(client, userId);
    if (!row) return { kind: 'no_pin' as const };
    const now = new Date();
    if (row.lockedUntil && row.lockedUntil > now) return { kind: 'locked' as const, until: row.lockedUntil };

    if (await pinMatches(pin, row.pinHash)) {
      await resetPinFailures(client, userId);
      return { kind: 'ok' as const };
    }
    const failed = row.failedAttempts + 1;
    if (failed >= MAX_FAILED_ATTEMPTS) {
      const until = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      await recordPinFailure(client, { userId, failedAttempts: 0, lockedUntil: until });
      return { kind: 'locked' as const, until };
    }
    await recordPinFailure(client, { userId, failedAttempts: failed, lockedUntil: null });
    return { kind: 'wrong' as const, remaining: MAX_FAILED_ATTEMPTS - failed };
  });

  switch (outcome.kind) {
    case 'ok':
      return;
    case 'no_pin':
      throw new AppError(409, 'PIN_NOT_SET', 'กรุณาตั้ง PIN ลงนามก่อน');
    case 'locked':
      throw lockedError(outcome.until);
    case 'wrong':
      throw new AppError(403, 'PIN_INCORRECT', `PIN ไม่ถูกต้อง (ใส่ผิดได้อีก ${outcome.remaining} ครั้งก่อนถูกล็อก ${LOCK_MINUTES} นาที)`);
  }
}

/**
 * ตั้ง/เปลี่ยน PIN ลงนาม
 * - ยังไม่เคยตั้ง: ตั้งได้เลย
 * - เคยตั้งแล้ว: ใส่ PIN เดิมให้ถูก (นับครั้งที่ผิดเหมือนตอนลงนาม) หรือ login ใหม่ภายใน 10 นาทีที่ผ่านมา (กรณีลืม PIN)
 *   กันผู้ที่ได้ session ไปเปลี่ยน PIN แล้วลงนามแทนเจ้าของ
 */
export async function setSigningPin(
  user: AuthUser,
  sessionId: string,
  input: { currentPin: string | null; newPin: string },
): Promise<void> {
  if (!PIN_PATTERN.test(input.newPin)) throw new AppError(400, 'PIN_INVALID', 'PIN ต้องเป็นตัวเลข 6–12 หลัก');
  if (isWeakPin(input.newPin)) {
    throw new AppError(422, 'PIN_TOO_WEAK', 'PIN เดาง่ายเกินไป (เลขซ้ำกันหรือเรียงกัน) กรุณาตั้งใหม่');
  }

  const existing = await findSigningPin(pool, user.id);
  if (existing) {
    if (input.currentPin) {
      await verifySigningPin(user.id, input.currentPin);
    } else {
      const loggedInAt = await findSessionCreatedAt(pool, sessionId);
      const recent = loggedInAt !== null && Date.now() - loggedInAt.getTime() <= RECENT_LOGIN_MINUTES * 60_000;
      if (!recent) {
        throw new AppError(
          403,
          'RECENT_LOGIN_REQUIRED',
          `ใส่ PIN เดิม หรือออกจากระบบแล้วเข้าสู่ระบบใหม่ภายใน ${RECENT_LOGIN_MINUTES} นาทีเพื่อตั้ง PIN ใหม่`,
        );
      }
    }
  }
  await upsertSigningPin(pool, { userId: user.id, pinHash: await hashPin(input.newPin) });
}
