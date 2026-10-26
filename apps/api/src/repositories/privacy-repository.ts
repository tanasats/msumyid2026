import type { Queryable } from '../db/types.js';

/**
 * บันทึกการรับทราบประกาศ — ON CONFLICT DO NOTHING: กดซ้ำ (หรือกดพร้อมกัน 2 แท็บ) ไม่ error และคงเวลาครั้งแรกไว้
 */
export async function insertPrivacyAcknowledgement(
  db: Queryable,
  input: { userId: string; noticeVersion: number },
): Promise<void> {
  await db.query(
    `INSERT INTO privacy_acknowledgements (user_id, notice_version)
     VALUES ($1, $2)
     ON CONFLICT (user_id, notice_version) DO NOTHING`,
    [input.userId, input.noticeVersion],
  );
}
