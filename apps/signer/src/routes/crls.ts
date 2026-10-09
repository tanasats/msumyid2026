import express, { Router } from 'express';
import { z } from 'zod';
import { generateCrl } from '../services/crl-generator.js';

export const crlsRouter = Router();

const isoDate = z.iso.datetime().transform((v) => new Date(v));

const generateBody = z
  .object({
    // เลขฐาน 10 (BigInt) — CRL number ยาวได้ถึง 20 ไบต์
    crlNumber: z
      .string()
      .regex(/^[1-9][0-9]{0,47}$/)
      .transform((v) => BigInt(v)),
    thisUpdate: isoDate,
    nextUpdate: isoDate,
    revoked: z
      .array(
        z.object({
          serialNumber: z.string().regex(/^(0|[1-9a-f][0-9a-f]*)$/),
          revokedAt: isoDate,
          reason: z.enum([
            'unspecified',
            'keyCompromise',
            'CACompromise',
            'affiliationChanged',
            'superseded',
            'cessationOfOperation',
          ]),
          notAfter: isoDate,
        }),
      )
      .max(200_000),
  })
  .refine((v) => v.nextUpdate > v.thisUpdate, 'nextUpdate ต้องอยู่หลัง thisUpdate');

// สิทธิ์: เฉพาะ API ของระบบ (requireApiToken ใน app.ts)
// ออก CRL จากรายการใบที่ถูกเพิกถอนทั้งหมด — body ใหญ่ได้ตามจำนวนใบที่เพิกถอน
crlsRouter.post('/crls', express.json({ limit: '20mb' }), async (req, res) => {
  const input = generateBody.parse(req.body);
  const crl = await generateCrl(input);
  res.status(201).json({ crlDer: crl.toString('base64') });
});
