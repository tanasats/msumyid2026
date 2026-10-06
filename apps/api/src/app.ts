import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { requestLogger } from './middlewares/logger.js';
import { errorHandler, notFoundHandler } from './middlewares/error-handler.js';
import { healthRouter } from './routes/health.js';

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
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
