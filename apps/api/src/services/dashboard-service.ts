import { pool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import {
  countPendingUserApprovals,
  findLatestCrlInfo,
  getCertificateStats,
  getSigningQueueStats,
  getUserStats,
  type CertificateStats,
  type UserStats,
} from '../repositories/dashboard-repository.js';
import { countPendingPrimaryRequests } from '../repositories/primary-certificate-request-repository.js';
import { countPendingRequests as countPendingSupplementaryRequests } from '../repositories/supplementary-certificate-request-repository.js';
import { countPendingRevocationRequests } from '../repositories/certificate-revocation-request-repository.js';
import { canManageSystemSettings, hasPermission, type AuthUser } from './authorization-service.js';
import { PERMISSIONS } from './permissions.js';
import { signer } from './signer-client.js';

// หน้า "จัดการระบบ" (/admin, ตัดสินใจ 2026-10-30) — แต่ละหมวดใช้ permission ที่มีอยู่แล้ว ไม่มี permission ของหน้านี้เอง
// ผู้เรียกได้เฉพาะหมวดที่มีสิทธิ์ (super_admin ได้ครบ) ไม่มีสิทธิ์หมวดใดเลย = 403

const DAY_MS = 24 * 60 * 60 * 1000;
/** ช่วงของสถิติ (ผู้ใช้ใหม่ ใบที่ออก/เพิกถอน, ใบใกล้หมดอายุ) — 30 วันตายตัวไปก่อน */
export const DASHBOARD_WINDOW_DAYS = 30;
/** CRL ที่เผยแพร่อยู่เหลืออายุน้อยกว่านี้ = ต้องตรวจ (ค่าเดียวกับ STALE_WARN_HOURS ของ deploy/cdp/update-crl.sh) */
export const CRL_WARN_HOURS = 72;
/** งานลงนามที่ยังไม่จบค้างนานกว่านี้ = ต้องตรวจ (worker ไม่ทำงาน หรือ TSA/signer ล่มนาน) */
export const SIGNING_STALL_MINUTES = 15;

/** ok = ปกติ, warning = ต้องตรวจ, error = ใช้งานไม่ได้ */
export type HealthLevel = 'ok' | 'warning' | 'error';

export type Dashboard = {
  windowDays: number;
  /** งานที่รอดำเนินการ — มีเฉพาะคิวที่ผู้เรียกมีสิทธิ์ */
  pending: {
    userApprovals?: number;
    primaryRequests?: number;
    supplementaryRequests?: number;
    revocationRequests?: number;
  };
  users: UserStats | null;
  certificates: CertificateStats | null;
  system: {
    signer: HealthLevel;
    crl: { level: HealthLevel; crlNumber: string | null; thisUpdate: Date | null; nextUpdate: Date | null };
    signingQueue: { level: HealthLevel; pending: number; signing: number; oldestOpenAt: Date | null; failedLast24h: number };
  } | null;
};

/** signer ตอบไม่ได้ = error แต่หน้า dashboard ต้องแสดงได้เสมอ (log ไว้ ไม่กลืนเงียบ) */
async function checkSigner(): Promise<HealthLevel> {
  try {
    return (await signer.isHealthy()) ? 'ok' : 'error';
  } catch (err) {
    logger.warn({ err }, 'Signer health check failed');
    return 'error';
  }
}

async function getSystemStatus(now: Date): Promise<NonNullable<Dashboard['system']>> {
  const [signerLevel, crl, queue] = await Promise.all([
    checkSigner(),
    findLatestCrlInfo(pool),
    getSigningQueueStats(pool, new Date(now.getTime() - DAY_MS)),
  ]);

  // ไม่มี CRL หรือหมดอายุแล้ว = error, เหลือไม่ถึง CRL_WARN_HOURS = warning
  const crlLevel: HealthLevel =
    !crl || crl.nextUpdate <= now
      ? 'error'
      : crl.nextUpdate.getTime() - now.getTime() < CRL_WARN_HOURS * 60 * 60 * 1000
        ? 'warning'
        : 'ok';

  const stalled =
    queue.oldestOpenAt !== null && now.getTime() - queue.oldestOpenAt.getTime() > SIGNING_STALL_MINUTES * 60 * 1000;

  return {
    signer: signerLevel,
    crl: {
      level: crlLevel,
      // เลข CRL แสดงเป็นฐาน 16 ตัวพิมพ์ใหญ่แบบที่ openssl crl -crlnumber แสดง (เทียบกับ cdp ได้ทันที)
      crlNumber: crl ? crl.crlNumber.toString(16).toUpperCase() : null,
      thisUpdate: crl?.thisUpdate ?? null,
      nextUpdate: crl?.nextUpdate ?? null,
    },
    signingQueue: {
      level: stalled ? 'warning' : 'ok',
      pending: queue.pending,
      signing: queue.signing,
      oldestOpenAt: queue.oldestOpenAt,
      failedLast24h: queue.failedSince,
    },
  };
}

export async function getDashboard(actor: AuthUser, now = new Date()): Promise<Dashboard> {
  const canApproveUsers = hasPermission(actor, PERMISSIONS.USER_APPROVE);
  const canApproveCertificates = hasPermission(actor, PERMISSIONS.CERTIFICATE_APPROVE);
  const canRevoke = hasPermission(actor, PERMISSIONS.CERTIFICATE_REVOKE);
  const canReadUsers = hasPermission(actor, PERMISSIONS.USER_READ);
  const canReadCertificates = hasPermission(actor, PERMISSIONS.CERTIFICATE_READ);
  const canSeeSystem = canManageSystemSettings(actor);
  if (!(canApproveUsers || canApproveCertificates || canRevoke || canReadUsers || canReadCertificates || canSeeSystem)) {
    throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
  }

  const since = new Date(now.getTime() - DASHBOARD_WINDOW_DAYS * DAY_MS);
  const expiringBefore = new Date(now.getTime() + DASHBOARD_WINDOW_DAYS * DAY_MS);
  // แต่ละหมวดอ่านคนละตาราง ไม่ต้องอยู่ใน transaction เดียวกัน — ยิงพร้อมกัน
  const [userApprovals, primaryRequests, supplementaryRequests, revocationRequests, users, certificates, system] =
    await Promise.all([
      canApproveUsers ? countPendingUserApprovals(pool) : undefined,
      canApproveCertificates ? countPendingPrimaryRequests(pool) : undefined,
      canApproveCertificates ? countPendingSupplementaryRequests(pool) : undefined,
      canRevoke ? countPendingRevocationRequests(pool) : undefined,
      canReadUsers ? getUserStats(pool, since) : null,
      canReadCertificates ? getCertificateStats(pool, { now, since, expiringBefore }) : null,
      canSeeSystem ? getSystemStatus(now) : null,
    ]);

  return {
    windowDays: DASHBOARD_WINDOW_DAYS,
    pending: { userApprovals, primaryRequests, supplementaryRequests, revocationRequests },
    users,
    certificates,
    system,
  };
}
