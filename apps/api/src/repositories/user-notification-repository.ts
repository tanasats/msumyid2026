import type { Queryable } from '../db/types.js';

// การแจ้งเตือนในระบบ + การตั้งค่าการแจ้งเตือน (docs/design/notifications.md)

export type NotificationRow = {
  id: string;
  template: string;
  params: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
};

export type NotificationPreferenceRow = { category: string; inApp: boolean; email: boolean };

export async function insertNotification(
  db: Queryable,
  input: { userId: string; template: string; params: Record<string, unknown> },
): Promise<void> {
  await db.query(`INSERT INTO notifications (user_id, template, params) VALUES ($1, $2, $3)`, [
    input.userId,
    input.template,
    JSON.stringify(input.params),
  ]);
}

/**
 * รายการของผู้ใช้ ใหม่ก่อน — แบ่งหน้าด้วย cursor = id ตัวสุดท้ายของหน้าก่อน (uuidv7 เรียงตามเวลา, index notifications_user_id_idx)
 * ขอ limit + 1 แถวเพื่อรู้ว่ามีหน้าถัดไปหรือไม่
 */
export async function listNotificationsOfUser(
  db: Queryable,
  input: { userId: string; before: string | null; limit: number },
): Promise<NotificationRow[]> {
  const result = await db.query<NotificationRow>(
    `SELECT id, template, params, read_at AS "readAt", created_at AS "createdAt"
     FROM notifications
     WHERE user_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid)
     ORDER BY id DESC
     LIMIT $3`,
    [input.userId, input.before, input.limit],
  );
  return result.rows;
}

/** จำนวนที่ยังไม่อ่าน (partial index notifications_unread_idx) */
export async function countUnreadNotifications(db: Queryable, userId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return result.rows[0]!.n;
}

/** ทำเครื่องหมายว่าอ่านแล้ว — คืน false ถ้าไม่พบ (หรือเป็นของคนอื่น) อ่านซ้ำไม่เปลี่ยนเวลาเดิม */
export async function markNotificationRead(db: Queryable, input: { userId: string; id: string }): Promise<boolean> {
  const result = await db.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`,
    [input.id, input.userId],
  );
  return result.rowCount === 1;
}

export async function markAllNotificationsRead(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [
    userId,
  ]);
  return result.rowCount ?? 0;
}

/** ลบตามระยะเก็บ (ทุกสถานะ) */
export async function deleteNotificationsCreatedBefore(db: Queryable, before: Date): Promise<number> {
  const result = await db.query(`DELETE FROM notifications WHERE created_at < $1`, [before]);
  return result.rowCount ?? 0;
}

/** ลบบัญชี (PDPA): การแจ้งเตือนมีเหตุผล/บันทึกของผู้พิจารณา */
export async function deleteNotificationsOfUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
  return result.rowCount ?? 0;
}

export async function listNotificationPreferences(db: Queryable, userId: string): Promise<NotificationPreferenceRow[]> {
  const result = await db.query<NotificationPreferenceRow>(
    `SELECT category, in_app AS "inApp", email FROM notification_preferences WHERE user_id = $1 ORDER BY category`,
    [userId],
  );
  return result.rows;
}

/** ค่าของหมวดเดียว — null = ยังไม่เคยตั้ง (ใช้ค่าเริ่มต้น) */
export async function findNotificationPreference(
  db: Queryable,
  userId: string,
  category: string,
): Promise<{ inApp: boolean; email: boolean } | null> {
  const result = await db.query<{ inApp: boolean; email: boolean }>(
    `SELECT in_app AS "inApp", email FROM notification_preferences WHERE user_id = $1 AND category = $2`,
    [userId, category],
  );
  return result.rows[0] ?? null;
}

export async function upsertNotificationPreference(
  db: Queryable,
  input: { userId: string; category: string; inApp: boolean; email: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO notification_preferences (user_id, category, in_app, email) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, category) DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email`,
    [input.userId, input.category, input.inApp, input.email],
  );
}

export async function deleteNotificationPreferencesOfUser(db: Queryable, userId: string): Promise<void> {
  await db.query(`DELETE FROM notification_preferences WHERE user_id = $1`, [userId]);
}
