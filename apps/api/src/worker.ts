import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './middlewares/logger.js';
import { startSigningWorker } from './services/signing-worker-service.js';

// worker ลงนามเอกสาร — process แยกจาก API (image เดียวกัน คนละคำสั่ง) ไม่เปิด port
// dev: pnpm --filter api worker / production: service worker ใน deploy/compose.yml

// heartbeat: เขียนไฟล์ทุกรอบที่ดึงคิวสำเร็จ — healthcheck ของ container ตรวจว่าไฟล์เพิ่งถูกแก้ (DB ล่ม = ไม่แก้ = unhealthy)
const HEARTBEAT_FILE = path.join(tmpdir(), 'signing-worker-alive');

const worker = startSigningWorker(config.signingWorker.pollIntervalMs, async () => {
  await writeFile(HEARTBEAT_FILE, new Date().toISOString());
});
logger.info('worker ลงนามเอกสารเริ่มทำงาน');

// Graceful shutdown: รองานที่กำลังลงนามให้เสร็จ (ไม่กี่วินาที) แล้วค่อย pool.end()
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`ได้รับ ${signal} กำลังปิด worker...`);

  // กันค้าง: signer/TSA timeout รวมไม่เกิน ~45 วินาที — งานที่ถูกตัดกลางทางถูกคืนเข้าคิวเองเมื่อเกินเวลา
  const forceExit = setTimeout(() => {
    logger.error('ปิด worker ไม่ทันเวลา บังคับออก');
    process.exit(1);
  }, 60_000);
  forceExit.unref();

  worker
    .stop()
    .then(() => pool.end())
    .then(() => {
      logger.info('ปิด worker เรียบร้อย');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'ปิด worker ผิดพลาด');
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
