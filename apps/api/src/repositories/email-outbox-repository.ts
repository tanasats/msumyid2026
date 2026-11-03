import type { PoolClient } from 'pg';
import type { Queryable } from '../db/types.js';

// คิวอีเมลแจ้งเตือน (ตาราง email_outbox) — docs/design/email.md

export type DueEmailRow = {
  id: string;
  template: string;
  params: Record<string, unknown>;
  attempts: number;
  /** null = ผู้รับถูกลบบัญชีแล้ว (ไม่ส่ง) */
  recipientEmail: string | null;
  recipientName: string | null;
};

export async function insertEmail(
  db: Queryable,
  input: { recipientUserId: string; template: string; params: Record<string, unknown>; priority: 0 | 1 },
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO email_outbox (recipient_user_id, template, params, priority) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.recipientUserId, input.template, JSON.stringify(input.params), input.priority],
  );
  return result.rows[0]!.id;
}

/**
 * ดึงอีเมลที่ถึงเวลาส่ง 1 ฉบับ และล็อกแถวไว้จนจบ transaction ของผู้เรียก
 * SKIP LOCKED: API หลายตัวรันพร้อมกันได้โดยไม่ส่งซ้ำ — ผู้รับอ่านจาก users ตอนส่ง (อีเมลล่าสุด)
 * priority ก่อน (0 = ปกติ ส่งก่อนเตือนใบใกล้หมดอายุ) แล้วเวลา — ตรงกับ index email_outbox_due_idx
 */
export async function lockNextDueEmail(client: PoolClient, now: Date): Promise<DueEmailRow | null> {
  const result = await client.query<DueEmailRow>(
    `SELECT o.id, o.template, o.params, o.attempts,
            CASE WHEN u.deleted_at IS NULL THEN u.email END        AS "recipientEmail",
            CASE WHEN u.deleted_at IS NULL THEN u.display_name END AS "recipientName"
     FROM email_outbox o
     JOIN users u ON u.id = o.recipient_user_id
     WHERE o.status = 'pending' AND o.next_attempt_at <= $1
     ORDER BY o.priority, o.next_attempt_at
     LIMIT 1
     FOR UPDATE OF o SKIP LOCKED`,
    [now],
  );
  return result.rows[0] ?? null;
}

/** จำนวนอีเมลที่ส่งสำเร็จตั้งแต่เวลาที่ระบุ (index email_outbox_sent_at_idx) */
export async function countEmailsSentSince(db: Queryable, since: Date): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_outbox WHERE status = 'sent' AND sent_at >= $1`,
    [since],
  );
  return result.rows[0]!.n;
}

export async function markEmailSent(db: Queryable, id: string, now: Date): Promise<void> {
  await db.query(
    `UPDATE email_outbox SET status = 'sent', sent_at = $2, attempts = attempts + 1, last_error = NULL WHERE id = $1`,
    [id, now],
  );
}

/** ส่งไม่สำเร็จ: nextAttemptAt = null คือเลิกลอง (failed) */
export async function markEmailAttemptFailed(
  db: Queryable,
  input: { id: string; error: string; nextAttemptAt: Date | null },
): Promise<void> {
  await db.query(
    `UPDATE email_outbox
     SET attempts = attempts + 1,
         last_error = left($2, 1000),
         status = CASE WHEN $3::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
         next_attempt_at = COALESCE($3, next_attempt_at)
     WHERE id = $1`,
    [input.id, input.error, input.nextAttemptAt],
  );
}

export async function markEmailCancelled(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE email_outbox SET status = 'cancelled' WHERE id = $1`, [id]);
}

/** ลบตามระยะเก็บ (ทุกสถานะ) — คืนจำนวนที่ลบ */
export async function deleteEmailsCreatedBefore(db: Queryable, before: Date): Promise<number> {
  const result = await db.query(`DELETE FROM email_outbox WHERE created_at < $1`, [before]);
  return result.rowCount ?? 0;
}

/** ลบบัญชี (PDPA): ลบอีเมลของผู้ใช้ทั้งหมดทันที (params อาจมีบันทึกของผู้อนุมัติ) */
export async function deleteEmailsOfUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(`DELETE FROM email_outbox WHERE recipient_user_id = $1`, [userId]);
  return result.rowCount ?? 0;
}
