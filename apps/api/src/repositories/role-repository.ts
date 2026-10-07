import type { Queryable } from '../db/types.js';

/**
 * id ของผู้ใช้ (ที่ยังไม่ถูกลบ) ที่ถือ role นี้ — ใช้ index user_roles_role_id_idx
 * มี LIMIT เพราะผู้เรียกต้องการแค่รู้ว่ามีใครบ้าง ไม่ใช่รายการทั้งหมด
 */
export async function findRoleHolderIds(db: Queryable, roleCode: string, limit: number): Promise<string[]> {
  const result = await db.query<{ userId: string }>(
    `SELECT ur.user_id AS "userId"
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = ur.user_id
     WHERE r.code = $1
       AND u.deleted_at IS NULL
     ORDER BY ur.granted_at
     LIMIT $2`,
    [roleCode, limit],
  );
  return result.rows.map((row) => row.userId);
}

/**
 * ระบบให้ role อัตโนมัติ (ตอน login) ถ้าผู้ใช้ยังไม่มี พร้อมเขียน role_change_logs ใน statement เดียว
 * - r: หา id ของ role จาก code
 * - ins: INSERT ... ON CONFLICT DO NOTHING — ถ้ามี role อยู่แล้วจะไม่คืนแถว
 * - INSERT log จากผลของ ins จึงเขียน log เฉพาะเมื่อให้ role จริง (login ซ้ำไม่เกิด log ซ้ำ)
 * - granted_by / actor_id = NULL หมายถึงระบบเป็นผู้ให้
 * คืน true ถ้าเพิ่งให้ role ในครั้งนี้
 */
export async function grantRoleBySystem(
  db: Queryable,
  input: { userId: string; roleCode: string; reason: string },
): Promise<boolean> {
  const result = await db.query(
    `WITH r AS (
       SELECT id FROM roles WHERE code = $2
     ),
     ins AS (
       INSERT INTO user_roles (user_id, role_id)
       SELECT $1, r.id FROM r
       ON CONFLICT (user_id, role_id) DO NOTHING
       RETURNING role_id
     )
     INSERT INTO role_change_logs (actor_id, target_user_id, role_id, action, reason)
     SELECT NULL, $1, ins.role_id, 'grant', $3 FROM ins`,
    [input.userId, input.roleCode, input.reason],
  );
  return (result.rowCount ?? 0) > 0;
}
