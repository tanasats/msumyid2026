import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { getMyStaffProfile } from '../services/staff-profile-service.js';

export const meRouter = Router();

// สิทธิ์: ต้อง login เท่านั้น (ไม่ต้องมี permission) — ดูข้อมูลบุคลากรของตัวเองเท่านั้น
meRouter.get('/me/staff-profile', requireAuth, async (req, res) => {
  const staffProfile = await getMyStaffProfile(req.user!);
  res.json({ staffProfile });
});
