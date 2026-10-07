import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import type { Queryable } from '../db/types.js';
import { logger } from '../middlewares/logger.js';
import {
  deleteSessionByHash,
  deleteSessionsByUser,
  findSessionUser,
  insertSession,
  touchSession,
} from '../repositories/session-repository.js';
import type { AuthUser } from './authorization-service.js';

// token ดิบอยู่แค่ใน cookie ของผู้ใช้ ฐานข้อมูลเก็บเฉพาะ SHA-256
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// token 32 ไบต์ (256 บิต) แบบ base64url ใส่ cookie ได้โดยไม่ต้อง encode
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * สร้าง session ใหม่ — รับ db เพื่อให้เรียกใน transaction เดียวกับการสร้างผู้ใช้ได้
 */
export async function createSession(
  db: Queryable,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.session.ttlMs);
  await insertSession(db, { tokenHash: hashSessionToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * อ่านผู้ใช้จาก session token — อ่านจากฐานข้อมูลใหม่ทุกครั้ง (ไม่เชื่อข้อมูลจาก client)
 * คืน null ถ้า token ไม่ถูกต้อง หมดอายุ หรือผู้ใช้ถูกระงับ
 */
export async function resolveSession(token: string): Promise<{ sessionId: string; user: AuthUser } | null> {
  if (!TOKEN_PATTERN.test(token)) return null;

  const row = await findSessionUser(pool, hashSessionToken(token));
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
      roles: row.roles,
      permissions: row.permissions,
    },
  };
}

export async function revokeSession(token: string): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) return;
  await deleteSessionByHash(pool, hashSessionToken(token));
}
