import type { Queryable } from '../db/types.js';

// MFA (docs/design/mfa.md): TOTP 1 ชุดต่อผู้ใช้ (secret เข้ารหัสแล้ว) + รหัสกู้คืน (เก็บเฉพาะ SHA-256)

export type MfaTotpStatusRow = {
  confirmedAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
};

export type MfaTotpRow = MfaTotpStatusRow & {
  secretCiphertext: Buffer;
  keyId: string;
  lastUsedStep: number | null;
};

/** สถานะอย่างเดียว ไม่อ่าน secret */
export async function findMfaTotpStatus(db: Queryable, userId: string): Promise<MfaTotpStatusRow | null> {
  const result = await db.query<MfaTotpStatusRow>(
    `SELECT confirmed_at    AS "confirmedAt",
            failed_attempts AS "failedAttempts",
            locked_until    AS "lockedUntil"
     FROM user_mfa_totp
     WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * อ่านพร้อมล็อกแถว — ตรวจรหัสพร้อมกันหลายคำขอต้องทำทีละคำขอ จำนวนครั้งที่ผิดและ last_used_step จึงถูกต้อง
 * (รหัสเดียวกันส่งมาพร้อมกัน 2 คำขอ ผ่านได้แค่คำขอแรก)
 * last_used_step เป็น bigint — pg คืนเป็น string จึงแปลงใน SQL (ช่วงเวลา unix/30 ยังห่างจากขีดจำกัดของ integer ใน JS มาก)
 */
export async function lockMfaTotp(db: Queryable, userId: string): Promise<MfaTotpRow | null> {
  const result = await db.query<MfaTotpRow>(
    `SELECT secret_ciphertext       AS "secretCiphertext",
            key_id                  AS "keyId",
            confirmed_at            AS "confirmedAt",
            last_used_step::float8  AS "lastUsedStep",
            failed_attempts         AS "failedAttempts",
            locked_until            AS "lockedUntil"
     FROM user_mfa_totp
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * เริ่มตั้งค่า: เก็บ secret ใหม่ที่ยังไม่ยืนยัน — ทับได้เฉพาะแถวที่ยังไม่ยืนยัน (เริ่มใหม่ได้ถ้าสแกนไม่สำเร็จ)
 * คืน false เมื่อเปิด MFA อยู่แล้ว (แถวที่ยืนยันแล้วไม่ถูกแตะ)
 */
export async function upsertPendingMfaTotp(
  db: Queryable,
  input: { userId: string; secretCiphertext: Buffer; keyId: string },
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO user_mfa_totp (user_id, secret_ciphertext, key_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET secret_ciphertext = EXCLUDED.secret_ciphertext,
           key_id            = EXCLUDED.key_id,
           last_used_step    = NULL,
           failed_attempts   = 0,
           locked_until      = NULL
       WHERE user_mfa_totp.confirmed_at IS NULL`,
    [input.userId, input.secretCiphertext, input.keyId],
  );
  return result.rowCount === 1;
}

/** ยืนยันรหัสแรกผ่าน = เปิด MFA */
export async function confirmMfaTotp(db: Queryable, input: { userId: string; step: number }): Promise<void> {
  await db.query(
    `UPDATE user_mfa_totp
     SET confirmed_at = now(), last_used_step = $2, failed_attempts = 0, locked_until = NULL
     WHERE user_id = $1`,
    [input.userId, input.step],
  );
}

/** ใช้รหัสผ่าน: ล้างจำนวนครั้งที่ผิด และบันทึกช่วงเวลา (กันใช้รหัสเดิมซ้ำ) — step = null เมื่อใช้รหัสกู้คืน */
export async function recordMfaSuccess(db: Queryable, input: { userId: string; step: number | null }): Promise<void> {
  await db.query(
    `UPDATE user_mfa_totp
     SET failed_attempts = 0,
         locked_until    = NULL,
         last_used_step  = COALESCE($2, last_used_step)
     WHERE user_id = $1`,
    [input.userId, input.step],
  );
}

export async function recordMfaFailure(
  db: Queryable,
  input: { userId: string; failedAttempts: number; lockedUntil: Date | null },
): Promise<void> {
  await db.query(`UPDATE user_mfa_totp SET failed_attempts = $2, locked_until = $3 WHERE user_id = $1`, [
    input.userId,
    input.failedAttempts,
    input.lockedUntil,
  ]);
}

/** ปิด/รีเซ็ต MFA และลบบัญชี (PDPA): ลบ secret และรหัสกู้คืนทั้งหมด — คืนว่าเคยเปิด MFA (ยืนยันแล้ว) หรือไม่ */
export async function deleteMfaOfUser(db: Queryable, userId: string): Promise<boolean> {
  await db.query(`DELETE FROM user_mfa_recovery_codes WHERE user_id = $1`, [userId]);
  const result = await db.query<{ confirmed: boolean }>(
    `DELETE FROM user_mfa_totp WHERE user_id = $1 RETURNING confirmed_at IS NOT NULL AS confirmed`,
    [userId],
  );
  return result.rows[0]?.confirmed ?? false;
}

/** ออกรหัสกู้คืนชุดใหม่: ลบชุดเดิม (รวมที่ยังไม่ใช้) แล้วเพิ่มชุดใหม่ในคำสั่งเดียวด้วย unnest ของ array */
export async function replaceRecoveryCodes(db: Queryable, input: { userId: string; codeHashes: Buffer[] }): Promise<void> {
  await db.query(`DELETE FROM user_mfa_recovery_codes WHERE user_id = $1`, [input.userId]);
  await db.query(
    `INSERT INTO user_mfa_recovery_codes (user_id, code_hash)
     SELECT $1, code_hash FROM unnest($2::bytea[]) AS t (code_hash)`,
    [input.userId, input.codeHashes],
  );
}

/** ใช้รหัสกู้คืน — ผ่านได้ครั้งเดียว (used_at IS NULL ใน WHERE กันใช้ซ้ำแม้ส่งพร้อมกัน) */
export async function consumeRecoveryCode(db: Queryable, input: { userId: string; codeHash: Buffer }): Promise<boolean> {
  const result = await db.query(
    `UPDATE user_mfa_recovery_codes
     SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [input.userId, input.codeHash],
  );
  return result.rowCount === 1;
}

export async function countUnusedRecoveryCodes(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM user_mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return result.rows[0]!.count;
}
