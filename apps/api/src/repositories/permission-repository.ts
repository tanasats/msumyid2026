import type { Queryable } from '../db/types.js';

/** code ของ permission ที่ลงทะเบียนทั้งหมด (จำนวนน้อยและคงที่ LIMIT กันพลาดไว้) */
export async function listPermissionCodes(db: Queryable): Promise<string[]> {
  const result = await db.query<{ code: string }>('SELECT code FROM permissions ORDER BY code LIMIT 1000');
  return result.rows.map((row) => row.code);
}

export type PermissionRow = { id: string; code: string; descriptionTh: string };

/** permission ทั้งหมดพร้อมคำอธิบาย (หน้ากำหนดสิทธิ์ของ role) */
export async function listPermissions(db: Queryable): Promise<PermissionRow[]> {
  const result = await db.query<PermissionRow>(
    `SELECT id, code, description_th AS "descriptionTh" FROM permissions ORDER BY code LIMIT 1000`,
  );
  return result.rows;
}
