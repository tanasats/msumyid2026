import { Router } from 'express';
import { requireAuth } from '../middlewares/auth.js';
import { getDashboard } from '../services/dashboard-service.js';

// หน้า "จัดการระบบ" (/admin)
// สิทธิ์: ต้อง login — service คืนเฉพาะหมวดที่มีสิทธิ์ (user:approve, certificate:approve, certificate:revoke,
// user:read, certificate:read, ตั้งค่าระบบ) ไม่มีสิทธิ์หมวดใดเลย = 403
export const adminDashboardRouter = Router();

adminDashboardRouter.get('/admin/dashboard', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await getDashboard(req.user!));
});
