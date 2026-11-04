import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireMfaPassed } from '../middlewares/auth.js';
import { acknowledgePrivacyNotice } from '../services/privacy-service.js';
import { getMyStaffProfile } from '../services/staff-profile-service.js';

export const meRouter = Router();

// สิทธิ์: ต้อง login เท่านั้น (ไม่ต้องมี permission) — ดูข้อมูลบุคลากรของตัวเองเท่านั้น
meRouter.get('/me/staff-profile', requireAuth, async (req, res) => {
  const staffProfile = await getMyStaffProfile(req.user!);
  res.json({ staffProfile });
});

const acknowledgeSchema = z.object({ version: z.number().int().positive() });

// สิทธิ์: ต้อง login และผ่าน MFA ของ session (ถ้าเปิดไว้) — รวมบัญชีรออนุมัติ/ถูกปฏิเสธ เพราะทุกคนต้องรับทราบก่อนใช้ระบบ
// ใช้ requireMfaPassed เพราะ requireAuth จะปฏิเสธผู้ที่ยังไม่รับทราบ
meRouter.post('/me/privacy-acknowledgement', requireMfaPassed, async (req, res) => {
  const { version } = acknowledgeSchema.parse(req.body);
  await acknowledgePrivacyNotice(req.user!, version);
  res.status(204).end();
});
