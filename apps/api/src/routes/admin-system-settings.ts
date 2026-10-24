import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth.js';
import { changeSystemSettings, getSystemSettingsForAdmin } from '../services/system-settings-service.js';

// ค่าตั้งของระบบ (หน้า /admin/settings)
// สิทธิ์: super_admin เท่านั้น — route ตรวจแค่ login ส่วน service ตรวจ canManageSystemSettings
export const adminSystemSettingsRouter = Router();

// ช่วงค่าตรงกับ CHECK ใน migration create-system-settings-table
const settingsBody = z.object({
  allowedEmailDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/, 'รูปแบบโดเมนไม่ถูกต้อง เช่น msu.ac.th'),
    )
    .min(1, 'ต้องมีอย่างน้อย 1 โดเมน')
    .max(20),
  sessionTtlDays: z.number().int().min(1).max(30),
  crlValidityDays: z.number().int().min(1).max(30),
  crlReissueHours: z.number().int().min(1).max(168),
  reason: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500),
});

// สิทธิ์: super_admin เท่านั้น — ค่าตั้งปัจจุบัน + ประวัติ 20 รายการล่าสุด
adminSystemSettingsRouter.get('/admin/system-settings', requireAuth, async (req, res) => {
  res.json(await getSystemSettingsForAdmin(req.user!));
});

// สิทธิ์: super_admin เท่านั้น — แก้ค่าตั้ง (ส่งครบทุกช่อง) มีผลทันที
adminSystemSettingsRouter.put('/admin/system-settings', requireAuth, async (req, res) => {
  await changeSystemSettings(req.user!, settingsBody.parse(req.body));
  res.json(await getSystemSettingsForAdmin(req.user!));
});
