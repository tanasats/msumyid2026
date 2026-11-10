import type { Queryable } from '../db/types.js';

export type ErpOrgUnitLevel = 'faculty' | 'department';
export type ErpOrgUnitMatchType = 'auto' | 'manual';

/**
 * หาหน่วยงานในระบบที่ชื่อตรงกับชื่อ ERP (คืน 1 แถว คอลัมน์ org_unit_id) — ใช้ร่วมกันระหว่างตอน login และตอนผู้ดูแลคืนให้ระบบจับคู่
 * ต้องเจอ "พอดี 1 แถว" ที่ยังใช้งานอยู่จึงจับคู่ (ชื่อซ้ำ = กำกวม ไม่จับคู่)
 * nameExpr = ตำแหน่ง parameter หรือ subquery ของชื่อ — เป็นค่าคงที่ในโค้ดเท่านั้น ห้ามส่งค่าจากผู้ใช้
 */
const matchByNameSql = (nameExpr: string) =>
  `SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END AS org_unit_id
   FROM org_units
   WHERE name_th = ${nameExpr} AND is_active`;

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
    `WITH match AS (${matchByNameSql('$2')})
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

export type ErpOrgUnitListStatus = 'unmatched' | 'auto' | 'manual' | 'all';

export type ErpOrgUnitListRow = {
  id: string;
  erpCode: string;
  nameTh: string;
  level: ErpOrgUnitLevel;
  matchType: ErpOrgUnitMatchType | null;
  orgUnit: { id: string; code: string; nameTh: string } | null;
  /** จำนวนบุคลากรที่ ERP ระบุว่าอยู่หน่วยงานนี้ (ระดับคณะหรือกอง) */
  staffCount: number;
  updatedAt: Date;
};

/**
 * รายการหน่วยงาน ERP สำหรับหน้าจับคู่ (แบ่งหน้า)
 * - status: unmatched = ยังไม่จับคู่, auto/manual = ตามวิธีจับคู่, all = ทั้งหมด
 * - q: ค้นจากชื่อ (ILIKE) หรือรหัส ERP ที่ขึ้นต้นด้วย q — ค่าจากผู้ใช้ส่งเป็น parameter เสมอ
 * - staffCount: subquery นับ staff_profiles ที่อ้างถึงแถวนี้ (ใช้ index faculty/department ของ staff_profiles)
 * - count(*) OVER (): จำนวนทั้งหมดที่ตรงเงื่อนไข (ก่อน LIMIT) ในคำสั่งเดียว ไม่ต้อง query นับแยก
 * - เรียง: ยังไม่จับคู่ก่อน แล้วตามจำนวนบุคลากร (แก้ตัวที่กระทบคนมากก่อน)
 */
export async function listErpOrgUnits(
  db: Queryable,
  input: { status: ErpOrgUnitListStatus; level: ErpOrgUnitLevel | null; q: string | null; limit: number; offset: number },
): Promise<{ items: ErpOrgUnitListRow[]; total: number }> {
  const result = await db.query<ErpOrgUnitListRow & { total: number }>(
    `SELECT e.id,
            e.erp_code   AS "erpCode",
            e.name_th    AS "nameTh",
            e.level,
            e.match_type AS "matchType",
            CASE WHEN o.id IS NOT NULL
                 THEN json_build_object('id', o.id, 'code', o.code, 'nameTh', o.name_th) END AS "orgUnit",
            (SELECT count(*)::int FROM staff_profiles sp
              WHERE sp.department_erp_org_unit_id = e.id OR sp.faculty_erp_org_unit_id = e.id) AS "staffCount",
            e.updated_at AS "updatedAt",
            count(*) OVER ()::int AS total
     FROM erp_org_units e
     LEFT JOIN org_units o ON o.id = e.org_unit_id
     WHERE ($1 = 'all' OR ($1 = 'unmatched' AND e.org_unit_id IS NULL) OR e.match_type = $1)
       AND ($2::text IS NULL OR e.level = $2)
       AND ($3::text IS NULL OR e.name_th ILIKE '%' || $3 || '%' OR e.erp_code LIKE $3 || '%')
     ORDER BY (e.org_unit_id IS NULL) DESC, "staffCount" DESC, e.name_th, e.id
     LIMIT $4 OFFSET $5`,
    [input.status, input.level, input.q, input.limit, input.offset],
  );
  const total = result.rows[0]?.total ?? 0;
  return { items: result.rows.map(({ total: _total, ...row }) => row), total };
}

/** จำนวนหน่วยงาน ERP ที่ยังไม่จับคู่ (ตัวเลขบนแท็บ) */
export async function countUnmatchedErpOrgUnits(db: Queryable): Promise<number> {
  const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM erp_org_units WHERE org_unit_id IS NULL`);
  return result.rows[0]!.n;
}

export type ErpOrgUnitMapping = { orgUnitId: string | null; matchType: ErpOrgUnitMatchType | null };

/** อ่านการจับคู่ปัจจุบันพร้อมล็อกแถว (FOR UPDATE) กันผู้ดูแล 2 คนแก้พร้อมกัน — ต้องเรียกใน transaction */
export async function findErpOrgUnitMappingForUpdate(db: Queryable, id: string): Promise<ErpOrgUnitMapping | null> {
  const result = await db.query<ErpOrgUnitMapping>(
    `SELECT org_unit_id AS "orgUnitId", match_type AS "matchType"
     FROM erp_org_units
     WHERE id = $1
     FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** ผู้ดูแลกำหนดหน่วยงานเอง — match_type = 'manual' ทำให้ upsertErpOrgUnit ตอน login ไม่ทับ */
export async function setManualErpOrgUnitMapping(db: Queryable, id: string, orgUnitId: string): Promise<void> {
  await db.query(`UPDATE erp_org_units SET org_unit_id = $2, match_type = 'manual' WHERE id = $1`, [id, orgUnitId]);
}

/**
 * คืนให้ระบบจับคู่จากชื่อ (กฎเดียวกับตอน login) — ชื่อตรงพอดี 1 แถว = auto, ไม่ตรง = ยังไม่จับคู่
 * subquery m คืน 1 แถวเสมอ (aggregate ไม่มี GROUP BY) UPDATE จึงเขียนแถวนี้แน่นอน — คืนการจับคู่ใหม่ไว้เขียน log
 */
export async function resetErpOrgUnitMappingToAuto(db: Queryable, id: string): Promise<ErpOrgUnitMapping> {
  const result = await db.query<ErpOrgUnitMapping>(
    `UPDATE erp_org_units e
     SET org_unit_id = m.org_unit_id,
         match_type  = CASE WHEN m.org_unit_id IS NOT NULL THEN 'auto' END
     FROM (${matchByNameSql('(SELECT name_th FROM erp_org_units WHERE id = $1)')}) m
     WHERE e.id = $1
     RETURNING e.org_unit_id AS "orgUnitId", e.match_type AS "matchType"`,
    [id],
  );
  return result.rows[0]!;
}

export type ErpOrgUnitMappingLogInput = {
  erpOrgUnitId: string;
  actorId: string;
  action: 'set_manual' | 'reset_auto';
  from: ErpOrgUnitMapping;
  to: ErpOrgUnitMapping;
  reason: string;
  affectedUsers: number;
};

/** เขียนประวัติการจับคู่ (append-only) — ต้องอยู่ใน transaction เดียวกับการเปลี่ยน */
export async function insertErpOrgUnitMappingLog(db: Queryable, input: ErpOrgUnitMappingLogInput): Promise<void> {
  await db.query(
    `INSERT INTO erp_org_unit_mapping_logs
       (erp_org_unit_id, actor_id, action, from_org_unit_id, from_match_type,
        to_org_unit_id, to_match_type, reason, affected_users)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.erpOrgUnitId,
      input.actorId,
      input.action,
      input.from.orgUnitId,
      input.from.matchType,
      input.to.orgUnitId,
      input.to.matchType,
      input.reason,
      input.affectedUsers,
    ],
  );
}

type MappingSide = { orgUnitName: string | null; matchType: ErpOrgUnitMatchType | null };

export type ErpOrgUnitMappingLogRow = {
  id: string;
  action: 'set_manual' | 'reset_auto';
  actor: { id: string; displayName: string } | null;
  from: MappingSide;
  to: MappingSide;
  reason: string;
  affectedUsers: number;
  createdAt: Date;
};

/**
 * ประวัติการจับคู่ของหน่วยงาน ERP หนึ่ง (ล่าสุดก่อน) พร้อมชื่อผู้ทำและชื่อหน่วยงานก่อน/หลัง
 * actor: ผู้ดูแลที่ถูกลบข้อมูลแล้ว (deleted_at) แสดงเป็น null
 */
export async function listErpOrgUnitMappingLogs(
  db: Queryable,
  erpOrgUnitId: string,
  limit: number,
): Promise<ErpOrgUnitMappingLogRow[]> {
  const result = await db.query<ErpOrgUnitMappingLogRow>(
    `SELECT l.id,
            l.action,
            CASE WHEN a.id IS NOT NULL
                 THEN json_build_object('id', a.id, 'displayName', a.display_name) END AS actor,
            json_build_object('orgUnitName', fo.name_th, 'matchType', l.from_match_type) AS "from",
            json_build_object('orgUnitName', t.name_th, 'matchType', l.to_match_type) AS "to",
            l.reason,
            l.affected_users AS "affectedUsers",
            l.created_at     AS "createdAt"
     FROM erp_org_unit_mapping_logs l
     LEFT JOIN users a      ON a.id = l.actor_id AND a.deleted_at IS NULL
     LEFT JOIN org_units fo ON fo.id = l.from_org_unit_id
     LEFT JOIN org_units t  ON t.id = l.to_org_unit_id
     WHERE l.erp_org_unit_id = $1
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $2`,
    [erpOrgUnitId, limit],
  );
  return result.rows;
}

/** มีหน่วยงาน ERP นี้หรือไม่ (ใช้ตอบ 404 ของหน้าประวัติ) */
export async function erpOrgUnitExists(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM erp_org_units WHERE id = $1`, [id]);
  return result.rowCount === 1;
}
