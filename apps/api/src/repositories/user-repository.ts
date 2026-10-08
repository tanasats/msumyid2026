import type { Queryable } from '../db/types.js';
import type { AccountType, ApprovalStatus } from './session-repository.js';

export type UpsertGoogleUserInput = {
  googleSub: string;
  email: string;
  /** ชื่อจาก Google */
  name: string;
  /** ชื่อแสดงจาก ERP-HR (บุคลากรที่เรียก ERP สำเร็จ) — null = ใช้ชื่อเดิมจาก staff_profiles หรือชื่อจาก Google */
  erpDisplayName: string | null;
  pictureUrl: string | null;
  /** ใช้เฉพาะตอนสร้างผู้ใช้ใหม่ */
  accountType: AccountType;
  /** รหัสคณะ 2 หลัก (นิสิต) — ใช้เฉพาะตอนสร้างผู้ใช้ใหม่ ไม่พบใน org_units = NULL */
  orgUnitCode: string | null;
  /** ใช้เฉพาะตอนสร้างผู้ใช้ใหม่ */
  approvalStatus: ApprovalStatus;
};

export type LoginUserRow = {
  id: string;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  /** true = เพิ่งสร้างในการ login ครั้งนี้ */
  inserted: boolean;
};

export type UserStatusRow = {
  id: string;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
};

/**
 * ค้นผู้ใช้ด้วย email แบบไม่สนตัวพิมพ์ (ใช้ index users_email_lower_idx)
 * email ไม่ UNIQUE (ตัวระบุจริงคือ google_sub) จึงคืนได้หลายแถว — LIMIT 2 พอให้ผู้เรียกรู้ว่าซ้ำ
 */
export async function findUsersByEmail(db: Queryable, email: string): Promise<UserStatusRow[]> {
  const result = await db.query<UserStatusRow>(
    `SELECT id,
            approval_status AS "approvalStatus",
            is_active       AS "isActive"
     FROM users
     WHERE lower(email) = lower($1)
       AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT 2`,
    [email],
  );
  return result.rows;
}

/**
 * สร้างหรืออัปเดตผู้ใช้จาก Google ใน statement เดียว (ค้นด้วย google_sub ไม่ใช้ email)
 * - ON CONFLICT (google_sub): ถ้ามีแล้วอัปเดตแค่ข้อมูลโปรไฟล์และเวลา login
 *   ส่วน account_type / approval_status / org_unit_id ไม่ถูกทับ
 *   และกันกรณี login ครั้งแรกพร้อมกัน 2 แท็บไม่ให้เกิด error UNIQUE
 * - DO UPDATE ... WHERE: ผู้ใช้ที่ถูกระงับหรือถูกลบจะไม่ถูกอัปเดตและไม่คืนแถว → คืน null
 * - (xmax = 0) เป็นวิธีมาตรฐานของ PostgreSQL บอกว่าแถวนี้เพิ่ง INSERT (แถวที่ถูก UPDATE จะมี xmax ไม่เป็น 0)
 * - org_unit_id หาจากรหัสคณะด้วย subquery ได้ NULL ถ้าไม่พบ
 * - display_name เลือกตามลำดับด้วย COALESCE (ค่าแรกที่ไม่เป็น NULL):
 *     1) ชื่อจาก ERP ที่ได้ใน login ครั้งนี้
 *     2) ชื่อจาก staff_profiles ที่เคยเก็บไว้ (ERP ล่มครั้งนี้ ชื่อบุคลากรไม่กลับไปเป็นชื่อ Google)
 *     3) ชื่อจาก Google (นิสิต/บุคลากรภายนอก หรือบุคลากรที่ยังไม่เคยดึง ERP สำเร็จ)
 *   ใน DO UPDATE อ้างแถวเดิมด้วย users.id ได้ จึงใช้ subquery หา staff_profiles ของผู้ใช้คนนั้น
 */
export async function upsertGoogleUser(db: Queryable, input: UpsertGoogleUserInput): Promise<LoginUserRow | null> {
  const result = await db.query<LoginUserRow>(
    `INSERT INTO users (google_sub, email, name, display_name, picture_url, account_type, org_unit_id,
                        approval_status, last_login_at)
     VALUES ($1, $2, $3, COALESCE($8::text, $3), $4, $5,
             (SELECT id FROM org_units WHERE code = $6 AND is_active),
             $7, now())
     ON CONFLICT (google_sub) DO UPDATE
       SET email         = EXCLUDED.email,
           name          = EXCLUDED.name,
           display_name  = COALESCE(
                             $8::text,
                             (SELECT sp.first_name_th || ' ' || sp.last_name_th
                              FROM staff_profiles sp
                              WHERE sp.user_id = users.id),
                             EXCLUDED.name
                           ),
           picture_url   = EXCLUDED.picture_url,
           last_login_at = now()
       WHERE users.is_active AND users.deleted_at IS NULL
     RETURNING id,
               account_type    AS "accountType",
               approval_status AS "approvalStatus",
               (xmax = 0)      AS inserted`,
    [
      input.googleSub,
      input.email,
      input.name,
      input.pictureUrl,
      input.accountType,
      input.orgUnitCode,
      input.approvalStatus,
      input.erpDisplayName,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * ตั้งหน่วยงานของบุคลากร (users.org_unit_id) จากข้อมูล ERP ที่เก็บไว้ (CLAUDE.md หัวข้อ 18)
 * - ใช้หน่วยงานที่จับคู่ของกอง/ฝ่ายก่อน ถ้าไม่มีจึงใช้ของคณะ/สำนัก (COALESCE) ไม่มีทั้งคู่ = NULL
 * - ผู้ใช้ที่ไม่มี staff_profiles: subquery m ไม่มีแถว จึงไม่ถูกแก้
 * - คำนวณจาก erp_org_units ทุกครั้ง การจับคู่ที่ผู้ดูแลแก้ภายหลังจึงมีผลใน login ถัดไปแม้ ERP ล่ม
 * - IS DISTINCT FROM: ไม่เขียนถ้าค่าเดิมตรงกันอยู่แล้ว (เทียบ NULL ได้ถูกต้อง ต่างจาก <>)
 */
export async function syncStaffOrgUnit(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `UPDATE users u
     SET org_unit_id = m.org_unit_id
     FROM (
       SELECT COALESCE(d.org_unit_id, f.org_unit_id) AS org_unit_id
       FROM staff_profiles sp
       LEFT JOIN erp_org_units d ON d.id = sp.department_erp_org_unit_id
       LEFT JOIN erp_org_units f ON f.id = sp.faculty_erp_org_unit_id
       WHERE sp.user_id = $1
     ) m
     WHERE u.id = $1
       AND u.org_unit_id IS DISTINCT FROM m.org_unit_id`,
    [userId],
  );
}
