import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { logger } from './logger.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'ไม่พบเส้นทางที่ร้องขอ'));
};

// รูปแบบ error เดียวกับ API: { error: { code, message } } ห้ามส่งรายละเอียดภายในออกไป
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof z.ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' } });
    return;
  }

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
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'เกิดข้อผิดพลาดภายในบริการเซ็น' } });
};
