import type { Queryable } from '../db/types.js';

/** code ของ permission ที่ลงทะเบียนทั้งหมด (จำนวนน้อยและคงที่ LIMIT กันพลาดไว้) */
export async function listPermissionCodes(db: Queryable): Promise<string[]> {
  const result = await db.query<{ code: string }>('SELECT code FROM permissions ORDER BY code LIMIT 1000');
  return result.rows.map((row) => row.code);
}
