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

export type RoleRow = {
  id: string;
  code: string;
  nameTh: string;
  isSystem: boolean;
  isPrivileged: boolean;
};

/** role ทั้งหมด (จำนวนน้อยและควบคุมโดยผู้ดูแล — LIMIT กันพลาด) เรียงตามชื่อไทย */
export async function listRoles(db: Queryable): Promise<RoleRow[]> {
  const result = await db.query<RoleRow>(
    `SELECT id,
            code,
            name_th       AS "nameTh",
            is_system     AS "isSystem",
            is_privileged AS "isPrivileged"
     FROM roles
     ORDER BY is_privileged DESC, name_th
     LIMIT 200`,
  );
  return result.rows;
}

export async function findRoleByCode(db: Queryable, code: string): Promise<RoleRow | null> {
  const result = await db.query<RoleRow>(
    `SELECT id,
            code,
            name_th       AS "nameTh",
            is_system     AS "isSystem",
            is_privileged AS "isPrivileged"
     FROM roles
     WHERE code = $1`,
    [code],
  );
  return result.rows[0] ?? null;
}

/**
 * ล็อกและนับผู้ใช้ที่ถือ role นี้ซึ่งยังใช้งานได้ (ไม่ถูกปิด/ลบ) — ใช้กันถอน/ปิด super_admin คนสุดท้าย
 * FOR UPDATE OF u: ล็อกแถวผู้ใช้เหล่านั้นจนจบ transaction
 *   ถ้า super_admin 2 คนปิดบัญชีกันเองพร้อมกัน คนที่สองต้องรอ แล้วจะนับได้ค่าที่ถูกต้อง (ไม่เหลือ 0 คน)
 * ORDER BY u.id: ล็อกตามลำดับเดียวกันทุกครั้ง ลดโอกาส deadlock
 * ไม่ใส่ LIMIT: FOR UPDATE + LIMIT อาจคืนแถวไม่ครบเมื่อมีแถวถูกแก้ระหว่างรอล็อก — ผู้ถือ role นี้มีจำนวนน้อยอยู่แล้ว
 * ผู้เรียกต้องเรียกฟังก์ชันนี้ "ก่อน" ล็อกผู้ใช้เป้าหมาย เพื่อให้ทุก transaction ล็อกตามลำดับเดียวกัน
 */
export async function lockActiveRoleHolderIds(db: Queryable, roleCode: string): Promise<string[]> {
  const result = await db.query<{ userId: string }>(
    `SELECT u.id AS "userId"
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = $1
       AND u.is_active
       AND u.deleted_at IS NULL
     ORDER BY u.id
     FOR UPDATE OF u`,
    [roleCode],
  );
  return result.rows.map((row) => row.userId);
}

/**
 * ผู้ดูแลให้ role พร้อมเขียน role_change_logs ใน statement เดียว (แบบเดียวกับ grantRoleBySystem)
 * ON CONFLICT DO NOTHING: มี role อยู่แล้ว → ไม่เขียน log และคืน false
 */
export async function grantRoleByActor(
  db: Queryable,
  input: { userId: string; roleId: string; actorId: string; reason: string },
): Promise<boolean> {
  const result = await db.query(
    `WITH ins AS (
       INSERT INTO user_roles (user_id, role_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_id) DO NOTHING
       RETURNING role_id
     )
     INSERT INTO role_change_logs (actor_id, target_user_id, role_id, action, reason)
     SELECT $3, $1, ins.role_id, 'grant', $4 FROM ins`,
    [input.userId, input.roleId, input.actorId, input.reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * ผู้ดูแลถอน role พร้อมเขียน role_change_logs ใน statement เดียว
 * DELETE ... RETURNING: ไม่มี role นี้อยู่ → ไม่เขียน log และคืน false
 */
export async function revokeRoleByActor(
  db: Queryable,
  input: { userId: string; roleId: string; actorId: string; reason: string },
): Promise<boolean> {
  const result = await db.query(
    `WITH del AS (
       DELETE FROM user_roles
       WHERE user_id = $1 AND role_id = $2
       RETURNING role_id
     )
     INSERT INTO role_change_logs (actor_id, target_user_id, role_id, action, reason)
     SELECT $3, $1, del.role_id, 'revoke', $4 FROM del`,
    [input.userId, input.roleId, input.actorId, input.reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** role ที่ผู้ใช้ถืออยู่ เฉพาะ code ที่ระบุ (เช่น หา role ประเภทบัญชีเดิมก่อนเปลี่ยนประเภท) — ANY(array) = อยู่ในรายการ */
export async function findUserRolesByCodes(db: Queryable, userId: string, codes: string[]): Promise<RoleRow[]> {
  const result = await db.query<RoleRow>(
    `SELECT r.id,
            r.code,
            r.name_th       AS "nameTh",
            r.is_system     AS "isSystem",
            r.is_privileged AS "isPrivileged"
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1
       AND r.code = ANY($2::text[])`,
    [userId, codes],
  );
  return result.rows;
}

/**
 * ถอนทุก role ของผู้ใช้พร้อมเขียน role_change_logs ทีละ role ใน statement เดียว (ใช้ตอนลบบัญชี)
 * DELETE ... RETURNING ส่งทุกแถวที่ลบไปให้ INSERT log — คืนจำนวน role ที่ถอน
 */
export async function revokeAllRolesByActor(
  db: Queryable,
  input: { userId: string; actorId: string; reason: string },
): Promise<number> {
  const result = await db.query(
    `WITH del AS (
       DELETE FROM user_roles WHERE user_id = $1 RETURNING role_id
     )
     INSERT INTO role_change_logs (actor_id, target_user_id, role_id, action, reason)
     SELECT $2, $1, del.role_id, 'revoke', $3 FROM del`,
    [input.userId, input.actorId, input.reason],
  );
  return result.rowCount ?? 0;
}
