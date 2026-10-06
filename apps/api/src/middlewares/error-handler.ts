import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { logger } from './logger.js';

// เส้นทางที่ไม่มีอยู่ → 404 รูปแบบเดียวกับ error อื่น
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'ไม่พบเส้นทางที่ร้องขอ'));
};

// error ทุกตัวมาจบที่นี่ที่เดียว ห้ามส่ง stack trace หรือรายละเอียด SQL ออกไป (CLAUDE.md หัวข้อ 7)
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof z.ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' } });
    return;
  }

  // body JSON ผิดรูปแบบ / ใหญ่เกิน limit (มาจาก express.json)
  const status = (err as { status?: number }).status;
  const type = (err as { type?: string }).type;
  if (status === 413 || type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'ข้อมูลมีขนาดใหญ่เกินกำหนด' } });
    return;
  }
  if (status === 400 && type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'รูปแบบ JSON ไม่ถูกต้อง' } });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในระบบ' } });
};
