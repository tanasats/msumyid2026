import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config/index.js';
import { AppError } from '../errors.js';

// เทียบ hash แทนข้อความดิบ เพื่อให้ timingSafeEqual ได้ความยาวเท่ากันเสมอ (ไม่รั่วความยาว token)
const expectedDigest = createHash('sha256').update(config.token).digest();

/** ผู้เรียกต้องเป็น API ของระบบ (Authorization: Bearer <SIGNER_TOKEN>) */
export const requireApiToken: RequestHandler = (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const digest = createHash('sha256').update(token).digest();
  if (!token || !timingSafeEqual(digest, expectedDigest)) {
    next(new AppError(401, 'UNAUTHENTICATED', 'token ไม่ถูกต้อง'));
    return;
  }
  next();
};
