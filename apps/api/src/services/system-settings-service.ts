import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import {
  getSystemSettings,
  getSystemSettingsValues,
  insertSystemSettingLog,
  listSystemSettingLogs,
  updateSystemSettings,
  type SystemSettings,
  type SystemSettingLog,
  type SystemSettingsValues,
} from '../repositories/system-settings-repository.js';
import { canManageSystemSettings, type AuthUser } from './authorization-service.js';

// ค่าตั้งของระบบที่ super_admin แก้ได้ (หน้า /admin/settings) — ค่าที่เป็น infra/secret ยังอยู่ใน env (src/config)
// ทุกจุดที่ใช้อ่านจากฐานข้อมูลทุกครั้ง แก้แล้วมีผลทันทีโดยไม่ต้อง restart

const LOG_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ค่าตั้งที่ใช้งาน — db ใช้เรียกใน transaction ของผู้เรียกได้ */
export function readSystemSettings(db: Queryable = pool): Promise<SystemSettingsValues> {
  return getSystemSettingsValues(db);
}

/** อายุ session ที่สร้างใหม่ (ms) */
export async function sessionTtlMs(db: Queryable = pool): Promise<number> {
  return (await getSystemSettingsValues(db)).sessionTtlDays * DAY_MS;
}

function assertCanManage(actor: AuthUser): void {
  if (!canManageSystemSettings(actor)) throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
}

export async function getSystemSettingsForAdmin(
  actor: AuthUser,
): Promise<{ settings: SystemSettings; logs: SystemSettingLog[] }> {
  assertCanManage(actor);
  const [settings, logs] = await Promise.all([getSystemSettings(pool), listSystemSettingLogs(pool, LOG_LIMIT)]);
  return { settings, logs };
}

/** โดเมนตัวพิมพ์เล็ก ไม่ซ้ำ เรียงตามที่กรอก */
function normalizeDomains(domains: string[]): string[] {
  return [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

/**
 * แก้ค่าตั้ง (super_admin เท่านั้น) — ล็อกแถว → แก้ → log ค่าก่อน/หลัง ใน transaction เดียว
 * ค่าที่ต้องสัมพันธ์กันตรวจที่นี่ก่อน (ฐานข้อมูลมี CHECK อีกชั้น)
 */
export async function changeSystemSettings(
  actor: AuthUser,
  input: SystemSettingsValues & { reason: string },
): Promise<SystemSettings> {
  assertCanManage(actor);
  const { reason, ...rest } = input;
  const values: SystemSettingsValues = { ...rest, allowedEmailDomains: normalizeDomains(rest.allowedEmailDomains) };
  if (values.allowedEmailDomains.length === 0) {
    throw new AppError(422, 'SETTINGS_INVALID', 'ต้องมีโดเมนที่ไม่ต้องรออนุมัติอย่างน้อย 1 โดเมน');
  }
  if (values.crlReissueHours >= values.crlValidityDays * 24) {
    throw new AppError(
      422,
      'SETTINGS_INVALID',
      'ต้องออก CRL ฉบับใหม่ก่อนฉบับเดิมหมดอายุ — รอบออกใหม่ (ชั่วโมง) ต้องน้อยกว่าอายุ CRL',
    );
  }

  return withTransaction(async (client) => {
    const before = await getSystemSettings(client, { forUpdate: true });
    const beforeValues: SystemSettingsValues = {
      allowedEmailDomains: before.allowedEmailDomains,
      sessionTtlDays: before.sessionTtlDays,
      crlValidityDays: before.crlValidityDays,
      crlReissueHours: before.crlReissueHours,
      primaryReissueLimit: before.primaryReissueLimit,
    };
    if (JSON.stringify(beforeValues) === JSON.stringify(values)) {
      throw new AppError(400, 'NO_CHANGES', 'ค่าเหมือนเดิม ไม่มีอะไรเปลี่ยน');
    }
    await updateSystemSettings(client, values, actor.id);
    await insertSystemSettingLog(client, { actorId: actor.id, before: beforeValues, after: values, reason });
    return getSystemSettings(client);
  });
}
