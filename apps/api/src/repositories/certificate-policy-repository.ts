import type { Queryable } from '../db/types.js';

// นโยบายอายุใบรับรอง — ตาราง certificate_policies มีแถวเดียว (id = true) สร้างใน migration

export type PrimaryValidityMode = 'days' | 'fixed_date';

/** ค่าที่แก้ได้ (ใช้ทั้งตอนอ่านและบันทึก) */
export type CertificatePolicySettings = {
  primaryMode: PrimaryValidityMode;
  primaryDays: number;
  primaryExpiryMonth: number;
  primaryExpiryDay: number;
  primaryMinDays: number;
  renewalWindowDays: number;
  supplementaryMaxDays: number;
  supplementaryMaxActive: number;
};

export type CertificatePolicy = CertificatePolicySettings & {
  updatedAt: Date;
  /** ผู้แก้ล่าสุด (NULL = ค่าเริ่มต้นจาก migration) */
  updatedBy: { id: string; displayName: string } | null;
};

const SETTINGS_COLUMNS = `p.primary_mode             AS "primaryMode",
            p.primary_days             AS "primaryDays",
            p.primary_expiry_month     AS "primaryExpiryMonth",
            p.primary_expiry_day       AS "primaryExpiryDay",
            p.primary_min_days         AS "primaryMinDays",
            p.renewal_window_days      AS "renewalWindowDays",
            p.supplementary_max_days   AS "supplementaryMaxDays",
            p.supplementary_max_active AS "supplementaryMaxActive"`;

/**
 * อ่านนโยบาย — forUpdate = ล็อกแถวไว้ก่อนแก้ (กันผู้ดูแล 2 คนแก้พร้อมกันแล้ว log ค่าก่อนหน้าผิด)
 * แถวถูกสร้างใน migration จึงต้องมีเสมอ
 */
export async function getCertificatePolicy(db: Queryable, options: { forUpdate?: boolean } = {}): Promise<CertificatePolicy> {
  const result = await db.query<CertificatePolicySettings & { updatedAt: Date; updatedById: string | null; updatedByName: string | null }>(
    `SELECT ${SETTINGS_COLUMNS},
            p.updated_at   AS "updatedAt",
            u.id           AS "updatedById",
            u.display_name AS "updatedByName"
     FROM certificate_policies p
     LEFT JOIN users u ON u.id = p.updated_by AND u.deleted_at IS NULL
     WHERE p.id = true
     ${options.forUpdate ? 'FOR UPDATE OF p' : ''}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('ไม่พบแถวนโยบายใบรับรอง (certificate_policies) — ยังไม่ได้รัน migration');
  const { updatedById, updatedByName, ...policy } = row;
  return { ...policy, updatedBy: updatedById ? { id: updatedById, displayName: updatedByName ?? '' } : null };
}

export async function updateCertificatePolicy(
  db: Queryable,
  settings: CertificatePolicySettings,
  actorId: string,
): Promise<void> {
  await db.query(
    `UPDATE certificate_policies
     SET primary_mode = $1,
         primary_days = $2,
         primary_expiry_month = $3,
         primary_expiry_day = $4,
         primary_min_days = $5,
         renewal_window_days = $6,
         supplementary_max_days = $7,
         supplementary_max_active = $8,
         updated_by = $9
     WHERE id = true`,
    [
      settings.primaryMode,
      settings.primaryDays,
      settings.primaryExpiryMonth,
      settings.primaryExpiryDay,
      settings.primaryMinDays,
      settings.renewalWindowDays,
      settings.supplementaryMaxDays,
      settings.supplementaryMaxActive,
      actorId,
    ],
  );
}

/** บันทึกประวัติการแก้ (append-only) — เก็บค่าก่อน/หลังทั้งชุด */
export async function insertCertificatePolicyLog(
  db: Queryable,
  input: { actorId: string; before: CertificatePolicySettings; after: CertificatePolicySettings },
): Promise<void> {
  await db.query(
    `INSERT INTO certificate_policy_logs (actor_id, before, after) VALUES ($1, $2, $3)`,
    [input.actorId, JSON.stringify(input.before), JSON.stringify(input.after)],
  );
}

export type CertificatePolicyLog = {
  id: string;
  actor: { id: string; displayName: string } | null;
  before: CertificatePolicySettings;
  after: CertificatePolicySettings;
  createdAt: Date;
};

/** ประวัติการแก้ล่าสุดก่อน */
export async function listCertificatePolicyLogs(db: Queryable, limit: number): Promise<CertificatePolicyLog[]> {
  const result = await db.query<Omit<CertificatePolicyLog, 'actor'> & { actorId: string; actorName: string | null }>(
    `SELECT l.id,
            l.actor_id     AS "actorId",
            u.display_name AS "actorName",
            l.before,
            l.after,
            l.created_at   AS "createdAt"
     FROM certificate_policy_logs l
     LEFT JOIN users u ON u.id = l.actor_id AND u.deleted_at IS NULL
     ORDER BY l.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows.map(({ actorId, actorName, ...log }) => ({
    ...log,
    // ผู้แก้ที่ถูกลบบัญชีแล้ว = ไม่แสดงชื่อ (PDPA)
    actor: actorName !== null ? { id: actorId, displayName: actorName } : null,
  }));
}
