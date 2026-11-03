import type { Queryable } from '../db/types.js';
import type { AccountType } from './session-repository.js';
import type { CertificateKind } from './certificate-repository.js';

// งานแจ้งเตือนตามรอบ (docs/design/email.md ระยะที่ 2)

export type ExpiringCertificateRow = {
  id: string;
  userId: string;
  kind: CertificateKind;
  serialNumber: string;
  notAfter: Date;
};

/**
 * ใบที่ถึงรอบเตือน daysBefore แต่ยังไม่เคยเตือนรอบนี้ — เฉพาะใบที่หมดอายุในช่วง (now + afterDays, now + daysBefore]
 * afterDays = รอบที่เล็กกว่าถัดไป: ใบที่เหลือน้อยกว่านั้นได้เฉพาะรอบเล็ก (ไม่ส่ง "อีก 30 วัน" ให้ใบที่เหลือ 5 วัน)
 * ไม่เตือน:
 * - ใบที่อายุทั้งใบสั้นกว่ารอบนี้ (เช่น ใบเสริม 20 วันไม่ได้รอบ 30 วัน — ได้ทันทีที่ออกซึ่งไม่มีประโยชน์)
 * - ใบที่เจ้าของมีใบชนิดเดียวกันที่ใช้งานอยู่และหมดอายุทีหลัง (ต่ออายุแล้ว)
 * - เจ้าของถูกปิด/ลบบัญชี หรือยังไม่อนุมัติ
 * ใช้ index certificates_active_not_after_idx (ช่วง not_after ของใบที่ไม่ถูกเพิกถอน)
 */
export async function listCertificatesDueForExpiryNotice(
  db: Queryable,
  input: { now: Date; daysBefore: number; afterDays: number; limit: number },
): Promise<ExpiringCertificateRow[]> {
  const result = await db.query<ExpiringCertificateRow>(
    `SELECT c.id, c.user_id AS "userId", c.kind, c.serial_number AS "serialNumber", c.not_after AS "notAfter"
     FROM certificates c
     JOIN users u ON u.id = c.user_id
     WHERE c.revoked_at IS NULL
       AND c.not_after >  $1::timestamptz + make_interval(days => $3)
       AND c.not_after <= $1::timestamptz + make_interval(days => $2)
       AND c.not_after - c.not_before > make_interval(days => $2)
       AND u.deleted_at IS NULL
       AND u.is_active
       AND u.approval_status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM certificate_expiry_notices n WHERE n.certificate_id = c.id AND n.days_before = $2
       )
       AND NOT EXISTS (
         SELECT 1 FROM certificates newer
         WHERE newer.user_id = c.user_id AND newer.kind = c.kind
           AND newer.revoked_at IS NULL AND newer.not_after > c.not_after
       )
     ORDER BY c.not_after
     LIMIT $4`,
    [input.now, input.daysBefore, input.afterDays, input.limit],
  );
  return result.rows;
}

/** บันทึกว่าเตือนรอบนี้แล้ว — คืน false ถ้ามีอยู่แล้ว (job อีกตัวทำไปก่อน) */
export async function insertExpiryNotice(db: Queryable, certificateId: string, daysBefore: number): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO certificate_expiry_notices (certificate_id, days_before) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [certificateId, daysBefore],
  );
  return result.rowCount === 1;
}

/** จองงานประจำวัน — คืน false ถ้าวันนี้ทำไปแล้ว (PK kind + run_on) */
export async function claimNotificationRun(db: Queryable, kind: string, runOn: string): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO notification_runs (kind, run_on) VALUES ($1, $2::date) ON CONFLICT DO NOTHING`,
    [kind, runOn],
  );
  return result.rowCount === 1;
}

export async function setNotificationRunQueued(db: Queryable, kind: string, runOn: string, queued: number): Promise<void> {
  await db.query(`UPDATE notification_runs SET queued = $3 WHERE kind = $1 AND run_on = $2::date`, [kind, runOn, queued]);
}

export type NotificationRecipientRow = {
  id: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  roles: string[];
  permissions: string[];
};

/**
 * ผู้ใช้ที่ใช้งานได้ซึ่งถือ role ที่มี permission ใดใน list หรือถือ role superAdminRole
 * คืน roles/permissions ให้ service ตัดสินด้วย hasPermission (ที่เดียวที่ super_admin ผ่านทุก permission) — SQL แค่คัดผู้ที่อาจมีสิทธิ์
 */
export async function listUsersWithAnyPermission(
  db: Queryable,
  input: { permissions: string[]; superAdminRole: string; limit: number },
): Promise<NotificationRecipientRow[]> {
  const result = await db.query<NotificationRecipientRow>(
    `SELECT u.id, u.email, u.display_name AS name, u.picture_url AS "pictureUrl",
            u.account_type AS "accountType", u.approval_status AS "approvalStatus",
            ARRAY(
              SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.code
            ) AS roles,
            ARRAY(
              SELECT DISTINCT p.code
              FROM user_roles ur
              JOIN role_permissions rp ON rp.role_id = ur.role_id
              JOIN permissions p ON p.id = rp.permission_id
              WHERE ur.user_id = u.id
              ORDER BY p.code
            ) AS permissions
     FROM users u
     WHERE u.deleted_at IS NULL
       AND u.is_active
       AND (u.account_expires_at IS NULL OR u.account_expires_at > now())
       AND u.approval_status = 'approved'
       AND EXISTS (
         SELECT 1
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         LEFT JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = u.id AND (r.code = $2 OR p.code = ANY($1::text[]))
       )
     ORDER BY u.id
     LIMIT $3`,
    [input.permissions, input.superAdminRole, input.limit],
  );
  return result.rows;
}
