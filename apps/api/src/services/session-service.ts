import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import type { Queryable } from '../db/types.js';
import { logger } from '../middlewares/logger.js';
import {
  deleteExpiredSessions,
  deleteSessionByHash,
  deleteSessionsByUser,
  findSessionUser,
  insertSession,
  touchSession,
} from '../repositories/session-repository.js';
import type { AuthUser } from './authorization-service.js';
import { PRIVACY_NOTICE_VERSION } from './privacy-service.js';
import { sessionTtlMs } from './system-settings-service.js';

// token ดิบอยู่แค่ใน cookie ของผู้ใช้ ฐานข้อมูลเก็บเฉพาะ SHA-256
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// token 32 ไบต์ (256 บิต) แบบ base64url ใส่ cookie ได้โดยไม่ต้อง encode
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * สร้าง session ใหม่ — รับ db เพื่อให้เรียกใน transaction เดียวกับการสร้างผู้ใช้ได้
 * อายุตามค่าตั้งของระบบ (session_ttl_days) ณ ตอนสร้าง — แก้ค่าแล้ว session เดิมคงวันหมดอายุเดิม
 */
export async function createSession(
  db: Queryable,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + (await sessionTtlMs(db)));
  await insertSession(db, { tokenHash: hashSessionToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * อ่านผู้ใช้จาก session token — อ่านจากฐานข้อมูลใหม่ทุกครั้ง (ไม่เชื่อข้อมูลจาก client)
 * คืน null ถ้า token ไม่ถูกต้อง หมดอายุ หรือผู้ใช้ถูกระงับ
 */
export async function resolveSession(token: string): Promise<{ sessionId: string; user: AuthUser } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;

  const row = await findSessionUser(pool, hashSessionToken(token), PRIVACY_NOTICE_VERSION);
  if (!row) return null;

  if (!row.isActive) {
    // ผู้ใช้ถูกระงับ → เข้าระบบไม่ได้ทันที และเพิกถอน session ทั้งหมดของเขา
    const revoked = await deleteSessionsByUser(pool, row.userId);
    logger.info({ userId: row.userId, revoked }, 'เพิกถอน session ของผู้ใช้ที่ถูกระงับ');
    return null;
  }

  await touchSession(pool, row.sessionId);

  return {
    sessionId: row.sessionId,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      pictureUrl: row.pictureUrl,
      accountType: row.accountType,
      approvalStatus: row.approvalStatus,
      privacyAcknowledged: row.privacyAcknowledged,
      roles: row.roles,
      permissions: row.permissions,
    },
  };
}

const CLEANUP_BATCH_SIZE = 1000;

/** ลบ session ที่หมดอายุทั้งหมด (ทีละชุด) — คืนจำนวนที่ลบ */
export async function purgeExpiredSessions(): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteExpiredSessions(pool, CLEANUP_BATCH_SIZE);
    total += deleted;
    if (deleted < CLEANUP_BATCH_SIZE) return total;
  }
}

/**
 * เริ่มลบ session หมดอายุตามรอบ (รอบแรกทันทีตอนเริ่ม API) — คืนฟังก์ชันหยุด สำหรับ graceful shutdown
 * error ไม่ทำให้ API ล้ม แต่ต้อง log ไว้ (รอบถัดไปจะลองใหม่)
 */
export function startSessionCleanupJob(intervalMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const deleted = await purgeExpiredSessions();
      if (deleted > 0) logger.info({ deleted }, 'ลบ session ที่หมดอายุ');
    } catch (err) {
      logger.error({ err }, 'ลบ session ที่หมดอายุไม่สำเร็จ');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function revokeSession(token: string): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) return;
  await deleteSessionByHash(pool, hashSessionToken(token));
}
