import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { requestLogger } from './middlewares/logger.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { csrfProtection } from './middlewares/csrf.js';
import { loadSession } from './middlewares/auth.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { adminCertificatePolicyRouter } from './routes/admin-certificate-policy.js';
import { adminCertificatesRouter } from './routes/admin-certificates.js';
import { adminRolesRouter } from './routes/admin-roles.js';
import { adminSystemSettingsRouter } from './routes/admin-system-settings.js';
import { adminSupplementaryRequestsRouter } from './routes/admin-supplementary-certificate-requests.js';
import { adminUsersRouter } from './routes/admin-users.js';
import { certificatesRouter } from './routes/certificates.js';
import { supplementaryCertificatesRouter } from './routes/supplementary-certificates.js';
import { primaryCertificateRequestsRouter } from './routes/primary-certificate-requests.js';
import { certificateRevocationRequestsRouter } from './routes/certificate-revocation-requests.js';
import { verifyRouter } from './routes/verify.js';
import { filesRouter } from './routes/files.js';
import { signingPinRouter } from './routes/signing-pin.js';
import { signingRouter } from './routes/signing.js';
import { signatureImageRouter } from './routes/signature-image.js';

// สร้าง Express app โดยไม่ listen เพื่อให้ test เรียกผ่าน supertest ได้
export function createApp() {
  const app = express();

  if (config.trustProxy !== undefined) {
    app.set('trust proxy', config.trustProxy);
  }

  app.use(helmet());
  // origin ต้องมาจาก CORS_ORIGIN เท่านั้น ห้าม * (CLAUDE.md หัวข้อ 7)
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(requestLogger);
  // ตรวจ CSRF ก่อนอ่าน body เพื่อปฏิเสธ request ปลอมให้เร็วที่สุด
  app.use(csrfProtection);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  // อ่านผู้ใช้จาก session ทุก request (ไม่บังคับ login — แต่ละ route ระบุสิทธิ์เอง)
  app.use(loadSession);

  app.use(healthRouter);
  app.use(authRouter);
  app.use(meRouter);
  app.use(adminUsersRouter);
  app.use(adminRolesRouter);
  app.use(adminSystemSettingsRouter);
  app.use(adminCertificatesRouter);
  app.use(adminCertificatePolicyRouter);
  app.use(adminSupplementaryRequestsRouter);
  app.use(certificatesRouter);
  app.use(supplementaryCertificatesRouter);
  app.use(primaryCertificateRequestsRouter);
  app.use(certificateRevocationRequestsRouter);
  app.use(verifyRouter);
  app.use(filesRouter);
  app.use(signingPinRouter);
  app.use(signingRouter);
  app.use(signatureImageRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
