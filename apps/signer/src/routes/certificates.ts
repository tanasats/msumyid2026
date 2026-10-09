import express, { Router } from 'express';
import { z } from 'zod';
import { issueCertificate } from '../services/certificate-issuer.js';

export const certificatesRouter = Router();

// ห้ามมีอักขระควบคุม (ขึ้นบรรทัดใหม่ ฯลฯ) ใน subject
const noControlChars = (v: string) => !/\p{Cc}/u.test(v);

const issueBody = z.object({
  // X.509 จำกัด commonName ไม่เกิน 64 ตัวอักษร (ub-common-name)
  commonName: z.string().trim().min(1).max(64).refine(noControlChars),
  email: z.email().max(255),
  p12Password: z.string().min(8).max(128).refine(noControlChars),
  legacyP12: z.boolean().default(false),
});

// สิทธิ์: เฉพาะ API ของระบบ (requireApiToken ใน app.ts) — API ตรวจสิทธิ์ของผู้ใช้และกำหนด subject จากฐานข้อมูลก่อนเรียก
// ออกใบรับรองใหม่: คืนใบรับรอง, .p12 (ล็อกด้วยรหัสผ่านของผู้ใช้) และ key สำรองที่เข้ารหัสแล้ว
certificatesRouter.post('/certificates', express.json({ limit: '16kb' }), async (req, res) => {
  const input = issueBody.parse(req.body);
  const issued = await issueCertificate(input);
  res.status(201).json({
    certificatePem: issued.certificatePem,
    serialNumber: issued.serialNumber,
    fingerprintSha256: issued.fingerprintSha256,
    notBefore: issued.notBefore.toISOString(),
    notAfter: issued.notAfter.toISOString(),
    p12: issued.p12.toString('base64'),
    escrow: {
      kekId: issued.escrow.kekId,
      encryptedKey: issued.escrow.encryptedKey.toString('base64'),
      wrappedDataKey: issued.escrow.wrappedDataKey.toString('base64'),
    },
  });
});
