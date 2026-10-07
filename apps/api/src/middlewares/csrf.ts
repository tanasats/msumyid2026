import type { RequestHandler } from 'express';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const allowedOrigin = new URL(config.webUrl).origin;

/**
 * กัน CSRF: request ที่เปลี่ยนข้อมูลต้องมี header Origin ตรงกับ WEB_URL (CLAUDE.md หัวข้อ 8)
 * browser ใส่ Origin ให้เองทุกครั้งที่ POST/PUT/PATCH/DELETE และเว็บอื่นปลอมไม่ได้
 * ไม่มี Origin = ปฏิเสธ (ปลอดภัยไว้ก่อน)
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (!UNSAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (req.get('origin') !== allowedOrigin) {
    next(new AppError(403, 'CSRF_REJECTED', 'คำขอไม่ได้มาจากเว็บไซต์ของระบบ'));
    return;
  }
  next();
};
