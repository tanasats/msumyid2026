import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { logger } from '../middlewares/logger.js';
import {
  deleteEmailsCreatedBefore,
  insertEmail,
  lockNextDueEmail,
  markEmailAttemptFailed,
  markEmailCancelled,
  markEmailSent,
} from '../repositories/email-outbox-repository.js';
import { EMAIL_TEMPLATES, renderEmail, type EmailNotice } from './templates.js';
import { MailError, mailTransport } from './transport.js';

// คิวอีเมล (docs/design/email.md): งานในระบบเรียก enqueueEmail ใน transaction ของงานนั้น แล้ว job ส่งตามรอบ

/** ระยะเก็บอีเมลในคิว (ประกาศความเป็นส่วนตัว) — เกินนี้ลบทุกสถานะ */
export const EMAIL_RETENTION_DAYS = 30;
/** ส่งไม่สำเร็จ: รอแล้วลองใหม่ตามลำดับนี้ (นาที) — ครบแล้วยังไม่ผ่าน = failed (รวมประมาณ 9 ชั่วโมง) */
export const EMAIL_RETRY_DELAYS_MINUTES = [1, 5, 30, 120, 360] as const;
/** จำนวนอีเมลสูงสุดต่อรอบ — โควตาของ Gmail Workspace ประมาณ 2,000 ฉบับ/วัน/บัญชี */
const BATCH_SIZE = 20;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * เขียนอีเมลลงคิว — เรียกด้วย client ของ transaction เดียวกับงานที่แจ้ง (งาน rollback = ไม่มีอีเมล)
 * ไม่ส่งทันที จึงไม่ทำให้งานช้าหรือล้มเมื่อ Gmail ล่ม
 */
export async function enqueueEmail(db: Queryable, recipientUserId: string, notice: EmailNotice): Promise<void> {
  await insertEmail(db, { recipientUserId, template: notice.template, params: notice.params });
}

type ProcessResult = 'sent' | 'retry' | 'failed' | 'cancelled' | null;

async function processOne(now: Date): Promise<ProcessResult> {
  return withTransaction(async (client) => {
    const email = await lockNextDueEmail(client, now);
    if (!email) return null;

    // ผู้รับถูกลบบัญชีระหว่างรอ — ไม่ส่ง (ลบบัญชีลบคิวของผู้ใช้อยู่แล้ว กรณีนี้กันไว้อีกชั้น)
    if (!email.recipientEmail) {
      await markEmailCancelled(client, email.id);
      return 'cancelled';
    }
    if (!(EMAIL_TEMPLATES as readonly string[]).includes(email.template)) {
      await markEmailAttemptFailed(client, { id: email.id, error: `ไม่รู้จักแม่แบบ ${email.template}`, nextAttemptAt: null });
      logger.error({ emailId: email.id, template: email.template }, 'อีเมลในคิวใช้แม่แบบที่ไม่มีแล้ว');
      return 'failed';
    }

    // params มาจาก enqueueEmail ที่ตรวจชนิดด้วย EmailNotice แล้ว
    const notice = { template: email.template, params: email.params } as EmailNotice;
    const rendered = renderEmail(notice, { recipientName: email.recipientName, webUrl: config.webUrl });
    try {
      await mailTransport.send({ to: email.recipientEmail, toName: email.recipientName, ...rendered });
    } catch (err) {
      const permanent = err instanceof MailError && err.permanent;
      const delay = permanent ? undefined : EMAIL_RETRY_DELAYS_MINUTES[email.attempts];
      const nextAttemptAt = delay === undefined ? null : new Date(Date.now() + delay * 60_000);
      const message = err instanceof Error ? err.message : String(err);
      await markEmailAttemptFailed(client, { id: email.id, error: message, nextAttemptAt });
      // ไม่ log ผู้รับ/เนื้อหา (ข้อมูลส่วนบุคคล) — ใช้ emailId ตามไปดูในตารางได้
      if (nextAttemptAt) {
        logger.warn({ emailId: email.id, template: email.template, attempt: email.attempts + 1, err: message }, 'ส่งอีเมลไม่สำเร็จ จะลองใหม่');
        return 'retry';
      }
      logger.error({ emailId: email.id, template: email.template, attempt: email.attempts + 1, err: message }, 'ส่งอีเมลไม่สำเร็จ เลิกลองแล้ว');
      return 'failed';
    }
    await markEmailSent(client, email.id, new Date());
    return 'sent';
  });
}

/** ส่งอีเมลที่ถึงเวลาในคิว (ไม่เกิน BATCH_SIZE ฉบับ) — คืนจำนวนตามผลลัพธ์ */
export async function processEmailOutbox(now = new Date()): Promise<Record<Exclude<ProcessResult, null>, number>> {
  const counts = { sent: 0, retry: 0, failed: 0, cancelled: 0 };
  for (let i = 0; i < BATCH_SIZE; i++) {
    const result = await processOne(now);
    if (!result) break;
    counts[result]++;
  }
  return counts;
}

/** ลบอีเมลที่เก่ากว่าระยะเก็บ (ทุกสถานะ) */
export async function purgeOldEmails(now = new Date()): Promise<number> {
  return deleteEmailsCreatedBefore(pool, new Date(now.getTime() - EMAIL_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}

export function startEmailJob(intervalMs: number): () => void {
  let running = false;
  let lastPurgeAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await processEmailOutbox();
      if (counts.sent + counts.retry + counts.failed + counts.cancelled > 0) logger.info(counts, 'ส่งอีเมลจากคิว');
      if (Date.now() - lastPurgeAt >= PURGE_INTERVAL_MS) {
        const deleted = await purgeOldEmails();
        lastPurgeAt = Date.now();
        if (deleted > 0) logger.info({ deleted }, 'ลบอีเมลที่เกินระยะเก็บ');
      }
    } catch (err) {
      logger.error({ err }, 'job ส่งอีเมลผิดพลาด');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
