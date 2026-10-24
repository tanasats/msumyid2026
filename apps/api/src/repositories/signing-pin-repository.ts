import type { Queryable } from '../db/types.js';

// PIN ลงนามเอกสาร — เก็บเฉพาะ hash (signing-pin-service)

export type SigningPinRow = {
  pinHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  updatedAt: Date;
};

const COLUMNS = `pin_hash        AS "pinHash",
            failed_attempts AS "failedAttempts",
            locked_until    AS "lockedUntil",
            updated_at      AS "updatedAt"`;

export async function findSigningPin(db: Queryable, userId: string): Promise<SigningPinRow | null> {
  const result = await db.query<SigningPinRow>(`SELECT ${COLUMNS} FROM signing_pins WHERE user_id = $1`, [userId]);
  return result.rows[0] ?? null;
}

/** อ่านพร้อมล็อกแถว — ตรวจ PIN พร้อมกันหลายคำขอต้องทำทีละคำขอ จำนวนครั้งที่ผิดจึงนับถูก */
export async function lockSigningPin(db: Queryable, userId: string): Promise<SigningPinRow | null> {
  const result = await db.query<SigningPinRow>(`SELECT ${COLUMNS} FROM signing_pins WHERE user_id = $1 FOR UPDATE`, [
    userId,
  ]);
  return result.rows[0] ?? null;
}

/** ตั้ง/เปลี่ยน PIN — ล้างจำนวนครั้งที่ผิดและการล็อก */
export async function upsertSigningPin(db: Queryable, input: { userId: string; pinHash: string }): Promise<void> {
  await db.query(
    `INSERT INTO signing_pins (user_id, pin_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL`,
    [input.userId, input.pinHash],
  );
}

export async function recordPinFailure(
  db: Queryable,
  input: { userId: string; failedAttempts: number; lockedUntil: Date | null },
): Promise<void> {
  await db.query(`UPDATE signing_pins SET failed_attempts = $2, locked_until = $3 WHERE user_id = $1`, [
    input.userId,
    input.failedAttempts,
    input.lockedUntil,
  ]);
}

export async function resetPinFailures(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `UPDATE signing_pins SET failed_attempts = 0, locked_until = NULL
     WHERE user_id = $1 AND (failed_attempts <> 0 OR locked_until IS NOT NULL)`,
    [userId],
  );
}

/** ลบบัญชี (PDPA) */
export async function deleteSigningPin(db: Queryable, userId: string): Promise<void> {
  await db.query(`DELETE FROM signing_pins WHERE user_id = $1`, [userId]);
}
