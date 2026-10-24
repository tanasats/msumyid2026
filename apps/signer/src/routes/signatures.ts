import express, { Router } from 'express';
import { z } from 'zod';
import { signCms } from '../services/certificate-issuer.js';

export const signaturesRouter = Router();

const base64 = z.base64().transform((v) => Buffer.from(v, 'base64'));

// ไฟล์ PDF ไม่เกิน 20 MB (ข้อมูลที่ลงนาม ≈ ขนาดไฟล์) — base64 ใหญ่ขึ้นราว 4/3 จึงตั้ง limit ไว้ 30 MB
const signBody = z.object({
  serialNumber: z.string().regex(/^(0|[1-9a-f][0-9a-f]*)$/),
  certificatePem: z.string().startsWith('-----BEGIN CERTIFICATE-----').max(16_000),
  escrow: z.object({
    kekId: z.string().min(1).max(32),
    encryptedKey: base64,
    wrappedDataKey: base64,
  }),
  content: base64.refine((b) => b.length > 0 && b.length <= 21 * 1024 * 1024, 'ข้อมูลที่ลงนามต้องไม่ว่างและไม่เกิน 21 MB'),
});

// สิทธิ์: เฉพาะ API ของระบบ (requireApiToken ใน app.ts) — API ตรวจ PIN, เจ้าของใบ และสถานะใบก่อนเรียก
// ลงนามข้อมูลด้วย key สำรองของผู้ใช้ คืน CMS SignedData แบบ detached (ใช้ฝังในลายมือชื่อ PDF)
signaturesRouter.post('/signatures/cms', express.json({ limit: '30mb' }), async (req, res) => {
  const input = signBody.parse(req.body);
  const cms = await signCms(input);
  res.json({ cms: cms.toString('base64') });
});
