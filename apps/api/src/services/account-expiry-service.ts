import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import { insertUserAuditLog, lockExpiredActiveUsers, setUserActive } from '../repositories/admin-user-repository.js';
import { deleteSessionsByUser } from '../repositories/session-repository.js';

// ปิดบัญชีที่ถึงวันหมดอายุ (บัญชีหน่วยงาน เช่น บัญชีกิจกรรม)
// การตัดสิทธิ์มีผลทันทีที่ถึงเวลาอยู่แล้ว (findSessionUser / upsertGoogleUser ตรวจ account_expires_at)
// job นี้ทำให้สถานะในฐานข้อมูลตรงกัน: is_active = false, เพิกถอน session และเขียน audit log ว่าระบบปิดเพราะหมดอายุ

const BATCH_SIZE = 100;

/** ปิดบัญชีที่หมดอายุทั้งหมดทีละชุด (ชุดละ 1 transaction) คืนจำนวนบัญชีที่ปิด */
export async function expireAccounts(): Promise<number> {
  let total = 0;
  for (;;) {
    const closed = await withTransaction(async (client) => {
      const users = await lockExpiredActiveUsers(client, BATCH_SIZE);
      for (const { id } of users) {
        await setUserActive(client, { userId: id, active: false, actorId: null });
        const revokedSessions = await deleteSessionsByUser(client, id);
        await insertUserAuditLog(client, {
          actorId: null,
          targetUserId: id,
          action: 'expire',
          changes: { isActive: { from: true, to: false }, revokedSessions },
          reason: 'บัญชีหมดอายุ ระบบปิดอัตโนมัติ',
        });
      }
      return users.length;
    });
    total += closed;
    if (closed < BATCH_SIZE) return total;
  }
}

/**
 * เริ่มตรวจตามรอบ (รอบแรกทันทีตอนเริ่ม API) — คืนฟังก์ชันหยุด สำหรับ graceful shutdown
 * error ไม่ทำให้ API ล้ม แต่ต้อง log ไว้ (รอบถัดไปจะลองใหม่)
 */
export function startAccountExpiryJob(intervalMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running) return; // รอบก่อนยังไม่เสร็จ
    running = true;
    try {
      const closed = await expireAccounts();
      if (closed > 0) logger.info({ closed }, 'ปิดบัญชีที่หมดอายุ');
    } catch (err) {
      logger.error({ err }, 'ปิดบัญชีที่หมดอายุไม่สำเร็จ');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
