import express from 'express';
import { requireApiToken } from './middlewares/auth.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { requestLogger } from './middlewares/logger.js';
import { certificatesRouter } from './routes/certificates.js';
import { crlsRouter } from './routes/crls.js';
import { loadCa } from './services/ca.js';

// บริการเซ็น: ถือ key ของ Intermediate CA และ KEK ของ key สำรอง — เปิดเฉพาะในเครือข่ายภายใน ให้ API เรียกเท่านั้น
// ไม่มี CORS/cookie เพราะ browser ไม่เรียกบริการนี้โดยตรง
// สร้าง app โดยไม่ listen เพื่อให้ test เรียกผ่าน supertest ได้
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(requestLogger);

  // สิทธิ์: public (ภายในเครือข่าย) — ตรวจว่าอ่าน CA ได้ ใช้กับ health check ของ container
  app.get('/health', async (_req, res) => {
    await loadCa();
    res.json({ status: 'ok' });
  });

  app.use(requireApiToken);
  // แต่ละ route อ่าน body ด้วยขนาดสูงสุดของตัวเอง (ออกใบ = เล็ก, ออก CRL = ตามจำนวนใบที่เพิกถอน)
  app.use(certificatesRouter);
  app.use(crlsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
