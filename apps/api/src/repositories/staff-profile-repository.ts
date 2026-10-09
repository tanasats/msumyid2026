import type { Queryable } from '../db/types.js';

export type UpsertStaffProfileInput = {
  staffId: string;
  prefixTh: string | null;
  firstNameTh: string;
  lastNameTh: string;
  prefixEn: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  positionTh: string | null;
  faculty: { erpCode: string } | null;
  department: { erpCode: string } | null;
  program: { code: string; nameTh: string } | null;
};

export type StaffProfileRow = {
  staffId: string;
  prefixTh: string | null;
  firstNameTh: string;
  lastNameTh: string;
  prefixEn: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  positionTh: string | null;
  facultyNameTh: string | null;
  departmentNameTh: string | null;
  programNameTh: string | null;
  /** หน่วยงานในระบบที่จับคู่ได้ (users.org_unit_id) */
  orgUnitNameTh: string | null;
  syncedAt: Date;
};

/**
 * บันทึกข้อมูลบุคลากรจาก ERP (1 แถวต่อผู้ใช้) — ต้องเรียก upsertErpOrgUnit ของคณะ/กองก่อน
 * เพราะอ้างถึง erp_org_units ด้วยรหัส ERP ผ่าน subquery (ไม่พบ = NULL)
 * ON CONFLICT (user_id): แทนที่ข้อมูลเดิมทั้งหมดด้วยข้อมูลล่าสุดจาก ERP
 */
export async function upsertStaffProfile(
  db: Queryable,
  userId: string,
  info: UpsertStaffProfileInput,
): Promise<void> {
  await db.query(
    `INSERT INTO staff_profiles (
       user_id, staff_id, prefix_th, first_name_th, last_name_th,
       prefix_en, first_name_en, last_name_en, position_th,
       faculty_erp_org_unit_id, department_erp_org_unit_id,
       program_erp_code, program_name_th, synced_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       (SELECT id FROM erp_org_units WHERE erp_code = $10),
       (SELECT id FROM erp_org_units WHERE erp_code = $11),
       $12, $13, now()
     )
     ON CONFLICT (user_id) DO UPDATE
       SET staff_id                   = EXCLUDED.staff_id,
           prefix_th                  = EXCLUDED.prefix_th,
           first_name_th              = EXCLUDED.first_name_th,
           last_name_th               = EXCLUDED.last_name_th,
           prefix_en                  = EXCLUDED.prefix_en,
           first_name_en              = EXCLUDED.first_name_en,
           last_name_en               = EXCLUDED.last_name_en,
           position_th                = EXCLUDED.position_th,
           faculty_erp_org_unit_id    = EXCLUDED.faculty_erp_org_unit_id,
           department_erp_org_unit_id = EXCLUDED.department_erp_org_unit_id,
           program_erp_code           = EXCLUDED.program_erp_code,
           program_name_th            = EXCLUDED.program_name_th,
           synced_at                  = EXCLUDED.synced_at`,
    [
      userId,
      info.staffId,
      info.prefixTh,
      info.firstNameTh,
      info.lastNameTh,
      info.prefixEn,
      info.firstNameEn,
      info.lastNameEn,
      info.positionTh,
      info.faculty?.erpCode ?? null,
      info.department?.erpCode ?? null,
      info.program?.code ?? null,
      info.program?.nameTh ?? null,
    ],
  );
}

/**
 * ข้อมูลบุคลากรของผู้ใช้ พร้อมชื่อคณะ/กองจาก erp_org_units และชื่อหน่วยงานในระบบจาก org_units
 * LEFT JOIN เพราะคณะ/กอง/หน่วยงานในระบบอาจไม่มี
 */
export async function findStaffProfileByUserId(db: Queryable, userId: string): Promise<StaffProfileRow | null> {
  const result = await db.query<StaffProfileRow>(
    `SELECT sp.staff_id         AS "staffId",
            sp.prefix_th        AS "prefixTh",
            sp.first_name_th    AS "firstNameTh",
            sp.last_name_th     AS "lastNameTh",
            sp.prefix_en        AS "prefixEn",
            sp.first_name_en    AS "firstNameEn",
            sp.last_name_en     AS "lastNameEn",
            sp.position_th      AS "positionTh",
            f.name_th           AS "facultyNameTh",
            d.name_th           AS "departmentNameTh",
            sp.program_name_th  AS "programNameTh",
            ou.name_th          AS "orgUnitNameTh",
            sp.synced_at        AS "syncedAt"
     FROM staff_profiles sp
     JOIN users u ON u.id = sp.user_id
     LEFT JOIN erp_org_units f ON f.id = sp.faculty_erp_org_unit_id
     LEFT JOIN erp_org_units d ON d.id = sp.department_erp_org_unit_id
     LEFT JOIN org_units ou ON ou.id = u.org_unit_id
     WHERE sp.user_id = $1
       AND u.deleted_at IS NULL`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** ลบข้อมูลบุคลากรของผู้ใช้ (ใช้ตอนลบข้อมูลส่วนบุคคล) */
export async function deleteStaffProfile(db: Queryable, userId: string): Promise<void> {
  await db.query('DELETE FROM staff_profiles WHERE user_id = $1', [userId]);
}
