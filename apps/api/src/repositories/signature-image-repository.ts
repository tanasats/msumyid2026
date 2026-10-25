import type { Queryable } from '../db/types.js';

// ภาพลายเซ็นของผู้ใช้ — 1 แถวต่อผู้ใช้ ตัวไฟล์อยู่ในตาราง files (purpose = 'signature_image')

export type SignatureImageRow = {
  fileId: string;
  objectKey: string;
  width: number;
  height: number;
  updatedAt: Date;
};

/** ภาพของผู้ใช้พร้อม object key — JOIN files เพื่อไม่คืนภาพที่ไฟล์ถูกลบไปแล้ว */
export async function findSignatureImage(db: Queryable, userId: string): Promise<SignatureImageRow | null> {
  const result = await db.query<SignatureImageRow>(
    `SELECT s.file_id     AS "fileId",
            f.object_key  AS "objectKey",
            s.width,
            s.height,
            s.updated_at  AS "updatedAt"
     FROM signature_images s
     JOIN files f ON f.id = s.file_id
     WHERE s.user_id = $1
       AND f.deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * ตั้ง/เปลี่ยนภาพ — คืน file_id ของภาพเดิม (null = ยังไม่เคยตั้ง หรือเป็นไฟล์เดิม) ให้ผู้เรียกตั้งไฟล์เดิมให้หมดอายุ
 * ต้องเรียกใน transaction: อ่านแถวเดิมพร้อมล็อก (FOR UPDATE กันเปลี่ยนพร้อมกัน 2 คำขอ) แล้วจึง upsert
 * (แยก 2 คำสั่งเพราะ CTE ที่มี FOR UPDATE ในคำสั่งเดียวกับ upsert จะเห็นแถวหลังแก้แล้ว ไม่ได้ค่าเดิม)
 */
export async function upsertSignatureImage(
  db: Queryable,
  input: { userId: string; fileId: string; width: number; height: number },
): Promise<string | null> {
  const old = await db.query<{ file_id: string }>(`SELECT file_id FROM signature_images WHERE user_id = $1 FOR UPDATE`, [
    input.userId,
  ]);
  await db.query(
    `INSERT INTO signature_images (user_id, file_id, width, height)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET file_id = EXCLUDED.file_id, width = EXCLUDED.width, height = EXCLUDED.height`,
    [input.userId, input.fileId, input.width, input.height],
  );
  const oldFileId = old.rows[0]?.file_id ?? null;
  return oldFileId === input.fileId ? null : oldFileId;
}

/** ลบภาพ — คืน file_id ที่ถูกลบ (null = ไม่มีภาพ) */
export async function deleteSignatureImage(db: Queryable, userId: string): Promise<string | null> {
  const result = await db.query<{ file_id: string }>(`DELETE FROM signature_images WHERE user_id = $1 RETURNING file_id`, [userId]);
  return result.rows[0]?.file_id ?? null;
}
