import type { Queryable } from '../db/types.js';

export type OrgUnitRow = { id: string; code: string; nameTh: string };

/** หน่วยงานที่ใช้งานอยู่ (ตัวเลือกในฟอร์ม) — จำนวนหลักสิบ LIMIT กันพลาด */
export async function listActiveOrgUnits(db: Queryable): Promise<OrgUnitRow[]> {
  const result = await db.query<OrgUnitRow>(
    `SELECT id, code, name_th AS "nameTh"
     FROM org_units
     WHERE is_active
     ORDER BY name_th
     LIMIT 500`,
  );
  return result.rows;
}

export async function findActiveOrgUnit(db: Queryable, id: string): Promise<OrgUnitRow | null> {
  const result = await db.query<OrgUnitRow>(
    `SELECT id, code, name_th AS "nameTh"
     FROM org_units
     WHERE id = $1 AND is_active`,
    [id],
  );
  return result.rows[0] ?? null;
}
