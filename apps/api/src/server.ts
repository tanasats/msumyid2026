import { createApp } from './app.js';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { logger } from './middlewares/logger.js';
import { startAccountExpiryJob } from './services/account-expiry-service.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`API พร้อมใช้งานที่ port ${config.port}`);
});

// ปิดบัญชีที่ถึงวันหมดอายุตามรอบ (ไม่เริ่มใน app.ts เพื่อไม่ให้ test ที่ใช้ app รัน job)
const stopAccountExpiryJob = startAccountExpiryJob(config.accountExpiryCheckIntervalMs);

server.on('error', (err) => {
  logger.fatal({ err }, 'เปิด HTTP server ไม่สำเร็จ');
  process.exit(1);
});

// Graceful shutdown: ปิด HTTP server (รอ request ที่ค้างอยู่) แล้วค่อย pool.end()
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`ได้รับ ${signal} กำลังปิดระบบ...`);
  stopAccountExpiryJob();

  // กันค้าง: ถ้าปิดไม่เสร็จใน 10 วินาทีให้บังคับออก
  const forceExit = setTimeout(() => {
    logger.error('ปิดระบบไม่ทันเวลา บังคับออก');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((closeErr) => {
    if (closeErr) logger.error({ err: closeErr }, 'ปิด HTTP server ผิดพลาด');
    pool
      .end()
      .then(() => {
        logger.info('ปิดระบบเรียบร้อย');
        process.exit(closeErr ? 1 : 0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'ปิด database pool ผิดพลาด');
        process.exit(1);
      });
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
