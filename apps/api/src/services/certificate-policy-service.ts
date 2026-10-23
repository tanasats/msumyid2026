import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import {
  getCertificatePolicy,
  insertCertificatePolicyLog,
  listCertificatePolicyLogs,
  updateCertificatePolicy,
  type CertificatePolicy,
  type CertificatePolicyLog,
  type CertificatePolicySettings,
} from '../repositories/certificate-policy-repository.js';
import type { AuthUser } from './authorization-service.js';

// นโยบายอายุใบรับรอง (docs/design/certificates.md หัวข้อ "ใบประจำตัว / ใบเสริม / นโยบายอายุ")
// อายุที่คำนวณได้ส่งให้ signer ซึ่งยังตัดให้ไม่เกินเพดาน CERT_VALIDITY_DAYS และอายุของ CA

export const DAY_MS = 24 * 60 * 60 * 1000;
/** เวลาประเทศไทย UTC+7 (ไม่มี daylight saving) */
export const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const POLICY_LOG_LIMIT = 20;

/** วันสุดท้ายของเดือน (ไม่นับ 29 ก.พ. — ใช้ได้ทุกปี) */
const MAX_DAY_OF_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** สิ้นวันที่ day/month ของปี year ตามเวลาประเทศไทย (23:59:59) */
function endOfDayBangkok(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59) - BANGKOK_OFFSET_MS);
}

/**
 * อายุใบประจำตัว (วัน) ถ้าออก ณ เวลา now
 * - days: ตามจำนวนวันที่กำหนด
 * - fixed_date: ถึงวัน/เดือนที่กำหนดของปีนี้ (เวลาประเทศไทย) ถ้าผ่านไปแล้วหรือเหลือน้อยกว่า primaryMinDays ใช้ปีถัดไป
 *   ปัดลงเป็นวันเต็ม — signer ออกใบด้วย -days จึงหมดอายุในวันที่กำหนด ณ เวลาเดียวกับที่ออก
 */
export function primaryValidityDays(policy: CertificatePolicySettings, now: Date): number {
  if (policy.primaryMode === 'days') return policy.primaryDays;

  const year = new Date(now.getTime() + BANGKOK_OFFSET_MS).getUTCFullYear();
  for (const candidate of [year, year + 1]) {
    const days = Math.floor(
      (endOfDayBangkok(candidate, policy.primaryExpiryMonth, policy.primaryExpiryDay).getTime() - now.getTime()) / DAY_MS,
    );
    if (days >= Math.max(policy.primaryMinDays, 1)) return days;
  }
  // primaryMinDays ≤ 365 จึงไม่ถึงตรงนี้ (ปีถัดไปเหลืออย่างน้อย 365 วัน)
  throw new Error('คำนวณอายุใบรับรองประจำตัวไม่ได้');
}

/** วันหมดอายุโดยประมาณของใบประจำตัวถ้าออก ณ เวลา now (ยังไม่ตัดตามอายุ CA ซึ่ง signer จัดการ) */
export function primaryExpiryPreview(policy: CertificatePolicySettings, now: Date): Date {
  return new Date(now.getTime() + primaryValidityDays(policy, now) * DAY_MS);
}

/** อายุสั้นที่สุดที่ใบประจำตัวอาจได้ — ช่วงต่ออายุต้องสั้นกว่านี้ ไม่เช่นนั้นผู้ใช้ขอใบประจำตัวใหม่ได้ตลอดเวลา */
function shortestPrimaryDays(policy: CertificatePolicySettings): number {
  return policy.primaryMode === 'days' ? policy.primaryDays : Math.max(policy.primaryMinDays, 1);
}

export function readCertificatePolicy(): Promise<CertificatePolicy> {
  return getCertificatePolicy(pool);
}

export async function getCertificatePolicyForAdmin(): Promise<{
  policy: CertificatePolicy;
  logs: CertificatePolicyLog[];
  primaryExpiryPreview: Date;
}> {
  const [policy, logs] = await Promise.all([getCertificatePolicy(pool), listCertificatePolicyLogs(pool, POLICY_LOG_LIMIT)]);
  return { policy, logs, primaryExpiryPreview: primaryExpiryPreview(policy, new Date()) };
}

/**
 * แก้นโยบาย (ต้องมี certificate_policy:manage — ตรวจที่ route) มีผลกับใบที่ออกหลังจากนี้เท่านั้น
 * ล็อกแถว → แก้ → เขียน log ค่าก่อน/หลัง ใน transaction เดียว
 */
export async function changeCertificatePolicy(actor: AuthUser, settings: CertificatePolicySettings): Promise<CertificatePolicy> {
  if (settings.primaryExpiryDay > MAX_DAY_OF_MONTH[settings.primaryExpiryMonth - 1]!) {
    throw new AppError(422, 'POLICY_INVALID', `เดือนที่ ${settings.primaryExpiryMonth} ไม่มีวันที่ ${settings.primaryExpiryDay}`);
  }
  if (settings.renewalWindowDays >= shortestPrimaryDays(settings)) {
    throw new AppError(
      422,
      'POLICY_INVALID',
      settings.primaryMode === 'days'
        ? 'ช่วงต่ออายุต้องสั้นกว่าอายุใบรับรองประจำตัว'
        : 'ช่วงต่ออายุต้องสั้นกว่าอายุขั้นต่ำของใบรับรองประจำตัว',
    );
  }

  return withTransaction(async (client) => {
    const before = await getCertificatePolicy(client, { forUpdate: true });
    await updateCertificatePolicy(client, settings, actor.id);
    await insertCertificatePolicyLog(client, { actorId: actor.id, before: pickSettings(before), after: settings });
    return getCertificatePolicy(client);
  });
}

function pickSettings(policy: CertificatePolicy): CertificatePolicySettings {
  return {
    primaryMode: policy.primaryMode,
    primaryDays: policy.primaryDays,
    primaryExpiryMonth: policy.primaryExpiryMonth,
    primaryExpiryDay: policy.primaryExpiryDay,
    primaryMinDays: policy.primaryMinDays,
    renewalWindowDays: policy.renewalWindowDays,
    supplementaryMaxDays: policy.supplementaryMaxDays,
    supplementaryMaxActive: policy.supplementaryMaxActive,
    supplementaryMaxLeadDays: policy.supplementaryMaxLeadDays,
  };
}
