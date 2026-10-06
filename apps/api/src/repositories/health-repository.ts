import type { Queryable } from '../db/types.js';

// ตรวจว่าเชื่อมต่อฐานข้อมูลได้ — SELECT 1 เบาที่สุด ไม่แตะตารางใด
export async function pingDatabase(db: Queryable): Promise<boolean> {
  const result = await db.query<{ ok: number }>('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}
