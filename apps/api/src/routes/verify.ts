import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { AppError } from '../errors.js';
import { isPdf, PdfFormatError } from '../services/signature-verification/pdf-signatures.js';
import { verifyPdfSignatures } from '../services/signature-verification/index.js';

export const verifyRouter = Router();

/** ขนาดไฟล์สูงสุด — ต้องตรงกับ client_max_body_size ของ location /api/verify/pdf ใน deploy/nginx/msumyid.conf */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

// endpoint สาธารณะที่ใช้ CPU (ตรวจลายมือชื่อ) จึงจำกัดต่อ IP — ผู้ใช้อัปโหลดจาก browser ตรง (ผ่าน nginx)
// ไม่ได้ผ่าน Next.js server จึงไม่มีปัญหา IP เดียวกันทุกผู้ใช้แบบ /auth/me
verifyRouter.use(
  '/verify/pdf',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code: 'TOO_MANY_REQUESTS', message: 'ตรวจเอกสารถี่เกินไป กรุณาลองใหม่ภายหลัง' },
      });
    },
  }),
);

// สิทธิ์: public — ใครก็ตรวจลายมือชื่อบนเอกสารได้ (ผู้รับเอกสารส่วนใหญ่ไม่มีบัญชีในระบบ)
// body = ไฟล์ PDF ดิบ (Content-Type: application/pdf) ตรวจในหน่วยความจำ ไม่บันทึกไฟล์ลงที่ใด
verifyRouter.post(
  '/verify/pdf',
  express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES }),
  async (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError(400, 'PDF_REQUIRED', 'กรุณาเลือกไฟล์ PDF');
    }
    if (!isPdf(body)) {
      throw new AppError(400, 'NOT_PDF', 'ไฟล์นี้ไม่ใช่ PDF');
    }

    let report;
    try {
      report = await verifyPdfSignatures(body);
    } catch (error) {
      if (error instanceof PdfFormatError) {
        throw new AppError(400, 'TOO_MANY_SIGNATURES', `ไฟล์มี${error.message} ระบบตรวจได้ไม่เกินจำนวนนี้`);
      }
      throw error;
    }

    // log เฉพาะขนาดและผลรวม ไม่ log ชื่อผู้ลงนามหรือเนื้อหาเอกสาร (PDPA)
    req.log.info(
      { bytes: body.length, verdicts: report.signatures.map((s) => s.verdict) },
      'verify pdf signatures',
    );
    res.set('Cache-Control', 'no-store').json(report);
  },
);
