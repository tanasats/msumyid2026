import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './middlewares/logger.js';
import { loadCa } from './services/ca.js';

// ตรวจ CA ก่อนเปิดรับ request: อ่านไฟล์ได้, passphrase ถูก, key คู่กับใบรับรอง — ผิดให้หยุดทันที
try {
  await loadCa();
} catch (err) {
  logger.fatal({ err }, 'โหลด CA ไม่สำเร็จ ตรวจ CA_CERT_PATH / CA_KEY_PATH / CA_KEY_PASSPHRASE');
  process.exit(1);
}

const server = createApp().listen(config.port, () => {
  logger.info(`บริการเซ็นพร้อมใช้งานที่ port ${config.port}`);
});

server.on('error', (err) => {
  logger.fatal({ err }, 'เปิด HTTP server ไม่สำเร็จ');
  process.exit(1);
});

// Graceful shutdown: รอ request ที่กำลังเซ็นอยู่ให้เสร็จก่อนปิด
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`ได้รับ ${signal} กำลังปิดระบบ...`);

  const forceExit = setTimeout(() => {
    logger.error('ปิดระบบไม่ทันเวลา บังคับออก');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((err) => {
    if (err) logger.error({ err }, 'ปิด HTTP server ผิดพลาด');
    else logger.info('ปิดระบบเรียบร้อย');
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
