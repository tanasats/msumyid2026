import type { Queryable } from '../db/types.js';
import type { AccountType, ApprovalStatus } from './session-repository.js';

export type UpsertGoogleUserInput = {
  googleSub: string;
  email: string;
  name: string;
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

/**
 * สร้างหรืออัปเดตผู้ใช้จาก Google ใน statement เดียว (ค้นด้วย google_sub ไม่ใช้ email)
 * - ON CONFLICT (google_sub): ถ้ามีแล้วอัปเดตแค่ข้อมูลโปรไฟล์และเวลา login
 *   ส่วน account_type / approval_status / org_unit_id ไม่ถูกทับ
 *   และกันกรณี login ครั้งแรกพร้อมกัน 2 แท็บไม่ให้เกิด error UNIQUE
 * - DO UPDATE ... WHERE: ผู้ใช้ที่ถูกระงับหรือถูกลบจะไม่ถูกอัปเดตและไม่คืนแถว → คืน null
 * - (xmax = 0) เป็นวิธีมาตรฐานของ PostgreSQL บอกว่าแถวนี้เพิ่ง INSERT (แถวที่ถูก UPDATE จะมี xmax ไม่เป็น 0)
 * - org_unit_id หาจากรหัสคณะด้วย subquery ได้ NULL ถ้าไม่พบ
 */
export async function upsertGoogleUser(db: Queryable, input: UpsertGoogleUserInput): Promise<LoginUserRow | null> {
  const result = await db.query<LoginUserRow>(
    `INSERT INTO users (google_sub, email, name, picture_url, account_type, org_unit_id, approval_status, last_login_at)
     VALUES ($1, $2, $3, $4, $5,
             (SELECT id FROM org_units WHERE code = $6 AND is_active),
             $7, now())
     ON CONFLICT (google_sub) DO UPDATE
       SET email         = EXCLUDED.email,
           name          = EXCLUDED.name,
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
    ],
  );
  return result.rows[0] ?? null;
}
