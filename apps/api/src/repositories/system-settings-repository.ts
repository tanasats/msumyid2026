import type { Queryable } from '../db/types.js';

// ค่าตั้งของระบบ — ตาราง system_settings มีแถวเดียว (id = true) สร้างใน migration

/** ค่าที่แก้ได้ (ใช้ทั้งตอนอ่านและบันทึก) */
export type SystemSettingsValues = {
  allowedEmailDomains: string[];
  sessionTtlDays: number;
  crlValidityDays: number;
  crlReissueHours: number;
  /** เพิกถอนใบประจำตัวเองได้กี่ครั้งต่อ 365 วันโดยยังสร้างใบใหม่เองได้ — เกินแล้วต้องส่งคำขอ */
  primaryReissueLimit: number;
};

export type SystemSettings = SystemSettingsValues & {
  updatedAt: Date;
  /** ผู้แก้ล่าสุด (NULL = ค่าเริ่มต้นจาก migration) */
  updatedBy: { id: string; displayName: string } | null;
};

const VALUE_COLUMNS = `s.allowed_email_domains AS "allowedEmailDomains",
            s.session_ttl_days      AS "sessionTtlDays",
            s.crl_validity_days     AS "crlValidityDays",
            s.crl_reissue_hours     AS "crlReissueHours",
            s.primary_reissue_limit AS "primaryReissueLimit"`;

/** ค่าตั้งที่ใช้งาน (อ่านทุกครั้งที่ต้องใช้ — แถวเดียวผ่าน PK จึงเร็ว และแก้แล้วมีผลทันทีโดยไม่ต้อง restart) */
export async function getSystemSettingsValues(db: Queryable): Promise<SystemSettingsValues> {
  const result = await db.query<SystemSettingsValues>(`SELECT ${VALUE_COLUMNS} FROM system_settings s WHERE s.id = true`);
  const row = result.rows[0];
  if (!row) throw new Error('ไม่พบแถวค่าตั้งของระบบ (system_settings) — ยังไม่ได้รัน migration');
  return row;
}

/** อ่านพร้อมผู้แก้ล่าสุด — forUpdate = ล็อกแถวก่อนแก้ (log ค่าก่อนหน้าถูกต้องเมื่อแก้พร้อมกัน) */
export async function getSystemSettings(db: Queryable, options: { forUpdate?: boolean } = {}): Promise<SystemSettings> {
  const result = await db.query<SystemSettingsValues & { updatedAt: Date; updatedById: string | null; updatedByName: string | null }>(
    `SELECT ${VALUE_COLUMNS},
            s.updated_at   AS "updatedAt",
            u.id           AS "updatedById",
            u.display_name AS "updatedByName"
     FROM system_settings s
     LEFT JOIN users u ON u.id = s.updated_by AND u.deleted_at IS NULL
     WHERE s.id = true
     ${options.forUpdate ? 'FOR UPDATE OF s' : ''}`,
  );
  const row = result.rows[0];
  if (!row) throw new Error('ไม่พบแถวค่าตั้งของระบบ (system_settings) — ยังไม่ได้รัน migration');
  const { updatedById, updatedByName, ...settings } = row;
  return { ...settings, updatedBy: updatedById ? { id: updatedById, displayName: updatedByName ?? '' } : null };
}

export async function updateSystemSettings(db: Queryable, values: SystemSettingsValues, actorId: string): Promise<void> {
  await db.query(
    `UPDATE system_settings
     SET allowed_email_domains = $1,
         session_ttl_days = $2,
         crl_validity_days = $3,
         crl_reissue_hours = $4,
         primary_reissue_limit = $5,
         updated_by = $6
     WHERE id = true`,
    [
      values.allowedEmailDomains,
      values.sessionTtlDays,
      values.crlValidityDays,
      values.crlReissueHours,
      values.primaryReissueLimit,
      actorId,
    ],
  );
}

export async function insertSystemSettingLog(
  db: Queryable,
  input: { actorId: string; before: SystemSettingsValues; after: SystemSettingsValues; reason: string },
): Promise<void> {
  await db.query(`INSERT INTO system_setting_logs (actor_id, before, after, reason) VALUES ($1, $2, $3, $4)`, [
    input.actorId,
    JSON.stringify(input.before),
    JSON.stringify(input.after),
    input.reason,
  ]);
}

export type SystemSettingLog = {
  id: string;
  actor: { id: string; displayName: string } | null;
  before: SystemSettingsValues;
  after: SystemSettingsValues;
  reason: string;
  createdAt: Date;
};

/** ประวัติการแก้ ล่าสุดก่อน */
export async function listSystemSettingLogs(db: Queryable, limit: number): Promise<SystemSettingLog[]> {
  const result = await db.query<Omit<SystemSettingLog, 'actor'> & { actorId: string; actorName: string | null }>(
    `SELECT l.id,
            l.actor_id     AS "actorId",
            u.display_name AS "actorName",
            l.before,
            l.after,
            l.reason,
            l.created_at   AS "createdAt"
     FROM system_setting_logs l
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
