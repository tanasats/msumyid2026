import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { enqueueEmail } from '../mail/outbox.js';
import type { ApproverDigestCounts } from '../mail/templates.js';
import { logger } from '../middlewares/logger.js';
import { countPendingRevocationRequests } from '../repositories/certificate-revocation-request-repository.js';
import { countPendingUserApprovals } from '../repositories/dashboard-repository.js';
import {
  claimNotificationRun,
  insertExpiryNotice,
  listCertificatesDueForExpiryNotice,
  listUsersWithAnyPermission,
  setNotificationRunQueued,
} from '../repositories/notification-repository.js';
import { countPendingPrimaryRequests } from '../repositories/primary-certificate-request-repository.js';
import { countPendingRequests as countPendingSupplementaryRequests } from '../repositories/supplementary-certificate-request-repository.js';
import { hasPermission, type AuthUser } from './authorization-service.js';
import { PERMISSIONS, SUPER_ADMIN_ROLE } from './permissions.js';

// งานแจ้งเตือนตามรอบ (docs/design/email.md ระยะที่ 2): เตือนใบใกล้หมดอายุ + สรุปงานค้างให้ผู้อนุมัติ
// ทั้งสองงานเขียนเฉพาะคิวอีเมล (email_outbox) — การส่งจริงเป็นของ job ใน mail/outbox.ts (มีเพดานต่อวัน)

/** รอบเตือนใบใกล้หมดอายุ (วันก่อนหมดอายุ) เรียงจากน้อยไปมาก */
export const EXPIRY_NOTICE_DAYS = [7, 30] as const;
/** จำนวนใบสูงสุดต่อรอบต่อรอบเตือน — ที่เหลือได้ในรอบถัดไป */
const EXPIRY_BATCH_SIZE = 200;
/** สรุปงานให้ผู้อนุมัติ: ตั้งแต่ 08:00 เวลาไทย วันจันทร์–ศุกร์ */
export const APPROVER_DIGEST_HOUR = 8;
const APPROVER_DIGEST_KIND = 'approver_digest';
const MAX_DIGEST_RECIPIENTS = 500;

/** เตือนใบใกล้หมดอายุที่ถึงรอบ — คืนจำนวนที่เข้าคิว */
export async function queueCertificateExpiryNotices(now = new Date()): Promise<number> {
  let queued = 0;
  for (const [index, daysBefore] of EXPIRY_NOTICE_DAYS.entries()) {
    const afterDays = index === 0 ? 0 : EXPIRY_NOTICE_DAYS[index - 1]!;
    const due = await listCertificatesDueForExpiryNotice(pool, { now, daysBefore, afterDays, limit: EXPIRY_BATCH_SIZE });
    for (const certificate of due) {
      // บันทึกรอบ + เข้าคิวใน transaction เดียว: insert ไม่สำเร็จ (มีแล้ว) = ไม่ส่งซ้ำ
      const inserted = await withTransaction(async (client) => {
        if (!(await insertExpiryNotice(client, certificate.id, daysBefore))) return false;
        await enqueueEmail(client, certificate.userId, {
          template: 'certificate_expiring',
          params: {
            kind: certificate.kind,
            serialNumber: certificate.serialNumber,
            notAfter: certificate.notAfter.toISOString(),
            daysBefore,
          },
        });
        return true;
      });
      if (inserted) queued++;
    }
  }
  return queued;
}

/** วันที่ (YYYY-MM-DD), ชั่วโมง และวันในสัปดาห์ ตามเวลาไทย */
function bangkokClock(now: Date): { date: string; hour: number; weekday: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: parts.weekday! };
}

/**
 * สรุปงานค้างให้ผู้อนุมัติ วันละครั้ง (หลัง 08:00 วันจันทร์–ศุกร์) — แต่ละคนเห็นเฉพาะคิวที่ตัวเองมีสิทธิ์ (hasPermission)
 * ไม่มีงานค้างในคิวที่มีสิทธิ์ = ไม่ส่ง | จองวันด้วย notification_runs ใน transaction เดียวกับการเข้าคิว (ล้ม = ลองใหม่รอบหน้า)
 * คืนจำนวนที่เข้าคิว หรือ null เมื่อยังไม่ถึงเวลา/ทำไปแล้ว
 */
export async function queueApproverDigest(now = new Date()): Promise<number | null> {
  const clock = bangkokClock(now);
  if (clock.hour < APPROVER_DIGEST_HOUR || clock.weekday === 'Sat' || clock.weekday === 'Sun') return null;

  return withTransaction(async (client) => {
    if (!(await claimNotificationRun(client, APPROVER_DIGEST_KIND, clock.date))) return null;

    // client เดียวใน transaction ส่ง query ทีละคำสั่งอยู่แล้ว — เรียกตามลำดับ (ฟังก์ชันนับเดียวกับหน้า /admin)
    const userApprovals = await countPendingUserApprovals(client);
    const primaryRequests = await countPendingPrimaryRequests(client);
    const supplementaryRequests = await countPendingSupplementaryRequests(client);
    const revocationRequests = await countPendingRevocationRequests(client);
    let queued = 0;
    if (userApprovals + primaryRequests + supplementaryRequests + revocationRequests > 0) {
      const candidates = await listUsersWithAnyPermission(client, {
        permissions: [PERMISSIONS.USER_APPROVE, PERMISSIONS.CERTIFICATE_APPROVE, PERMISSIONS.CERTIFICATE_REVOKE],
        superAdminRole: SUPER_ADMIN_ROLE,
        limit: MAX_DIGEST_RECIPIENTS,
      });
      for (const candidate of candidates) {
        // privacyAcknowledged ไม่มีผลต่อ hasPermission
        const user: AuthUser = { ...candidate, privacyAcknowledged: true };
        const counts: ApproverDigestCounts = {};
        if (hasPermission(user, PERMISSIONS.USER_APPROVE) && userApprovals > 0) counts.userApprovals = userApprovals;
        if (hasPermission(user, PERMISSIONS.CERTIFICATE_APPROVE)) {
          if (primaryRequests > 0) counts.primaryRequests = primaryRequests;
          if (supplementaryRequests > 0) counts.supplementaryRequests = supplementaryRequests;
        }
        if (hasPermission(user, PERMISSIONS.CERTIFICATE_REVOKE) && revocationRequests > 0) {
          counts.revocationRequests = revocationRequests;
        }
        if (Object.keys(counts).length === 0) continue;
        await enqueueEmail(client, user.id, { template: 'approver_digest', params: counts });
        queued++;
      }
    }
    await setNotificationRunQueued(client, APPROVER_DIGEST_KIND, clock.date, queued);
    return queued;
  });
}

export function startNotificationJob(intervalMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const expiring = await queueCertificateExpiryNotices();
      if (expiring > 0) logger.info({ queued: expiring }, 'เข้าคิวอีเมลเตือนใบใกล้หมดอายุ');
      const digest = await queueApproverDigest();
      if (digest !== null) logger.info({ queued: digest }, 'เข้าคิวสรุปงานให้ผู้อนุมัติ');
    } catch (err) {
      logger.error({ err }, 'job แจ้งเตือนตามรอบผิดพลาด');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
