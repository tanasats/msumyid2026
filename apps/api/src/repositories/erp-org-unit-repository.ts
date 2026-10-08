import type { Queryable } from '../db/types.js';

export type ErpOrgUnitLevel = 'faculty' | 'department';

/**
 * บันทึกหน่วยงานจาก ERP และจับคู่กับ org_units อัตโนมัติจากชื่อที่ตรงกัน (CLAUDE.md หัวข้อ 18)
 *
 * - CTE match: หา org_units ที่ชื่อตรงกันและยังใช้งานอยู่ ต้องเจอ "พอดี 1 แถว" จึงจับคู่
 *   (ถ้าชื่อซ้ำหลายหน่วยงาน ถือว่ากำกวม ไม่จับคู่) — PostgreSQL ไม่มี min(uuid) จึงใช้ (array_agg(id))[1]
 * - แถวใหม่: จับคู่ได้ = 'auto', จับคู่ไม่ได้ = ยังไม่จับคู่ (NULL)
 * - แถวเดิม: อัปเดตชื่อเสมอ ส่วนการจับคู่
 *     manual → คงเดิม ห้ามทับ
 *     auto/ยังไม่จับคู่ → คำนวณใหม่จากชื่อปัจจุบัน
 * - WHERE ... IS DISTINCT FROM: ไม่เขียนแถวซ้ำถ้าไม่มีอะไรเปลี่ยน (ลดการเขียนทุกครั้งที่ login และ updated_at มีความหมาย)
 */
export async function upsertErpOrgUnit(
  db: Queryable,
  input: { erpCode: string; nameTh: string; level: ErpOrgUnitLevel },
): Promise<void> {
  await db.query(
    `WITH match AS (
       SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS org_unit_id
       FROM org_units
       WHERE name_th = $2 AND is_active
     )
     INSERT INTO erp_org_units AS e (erp_code, name_th, level, org_unit_id, match_type)
     SELECT $1, $2, $3, match.org_unit_id,
            CASE WHEN match.org_unit_id IS NOT NULL THEN 'auto' END
     FROM match
     ON CONFLICT (erp_code) DO UPDATE
       SET name_th     = EXCLUDED.name_th,
           level       = EXCLUDED.level,
           org_unit_id = CASE WHEN e.match_type = 'manual' THEN e.org_unit_id ELSE EXCLUDED.org_unit_id END,
           match_type  = CASE WHEN e.match_type = 'manual' THEN e.match_type ELSE EXCLUDED.match_type END
       WHERE (e.name_th, e.level) IS DISTINCT FROM (EXCLUDED.name_th, EXCLUDED.level)
          OR (e.match_type IS DISTINCT FROM 'manual'
              AND (e.org_unit_id, e.match_type) IS DISTINCT FROM (EXCLUDED.org_unit_id, EXCLUDED.match_type))`,
    [input.erpCode, input.nameTh, input.level],
  );
}
