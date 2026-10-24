import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth.js';
import { createRole, getRoleAdminOverview, renameRole, setRolePermissions } from '../services/role-admin-service.js';

// กำหนด role และสิทธิ์ของ role (หน้า /admin/roles)
// สิทธิ์: super_admin เท่านั้น — route ตรวจแค่ login ส่วน service ตรวจ canManageRoles (ไม่ใช้ permission กันการยกระดับสิทธิ์)
// GET /admin/roles (รายการ role ให้เลือกตอนให้ role ผู้ใช้, user:read) อยู่ใน admin-users.ts
export const adminRolesRouter = Router();

const reason = z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500);
const nameTh = z.string().trim().min(1, 'กรุณากรอกชื่อ role').max(100);

// ตรงกับ CHECK ของ roles.code (ตัวพิมพ์เล็ก ตัวเลข _ ขึ้นต้นด้วยตัวอักษร)
const createBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,49}$/, 'รหัส role ใช้ a-z, 0-9 และ _ ขึ้นต้นด้วยตัวอักษร ยาว 2-50 ตัว'),
  nameTh,
  isPrivileged: z.boolean().default(false),
  reason,
});

const roleParams = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]*$/) });
const renameBody = z.object({ nameTh, reason });
const permissionsBody = z.object({
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/)).max(200),
  reason,
});

// สิทธิ์: super_admin เท่านั้น — role ทั้งหมด (จำนวนผู้ถือ + permission ที่ผูก), permission ทั้งหมด และประวัติล่าสุด
adminRolesRouter.get('/admin/role-permissions', requireAuth, async (req, res) => {
  res.json(await getRoleAdminOverview(req.user!));
});

// สิทธิ์: super_admin เท่านั้น — สร้าง role ใหม่
adminRolesRouter.post('/admin/role-permissions/roles', requireAuth, async (req, res) => {
  await createRole(req.user!, createBody.parse(req.body));
  res.status(201).json(await getRoleAdminOverview(req.user!));
});

// สิทธิ์: super_admin เท่านั้น — เปลี่ยนชื่อไทยของ role
adminRolesRouter.patch('/admin/role-permissions/roles/:code', requireAuth, async (req, res) => {
  const { code } = roleParams.parse(req.params);
  await renameRole(req.user!, code, renameBody.parse(req.body));
  res.json(await getRoleAdminOverview(req.user!));
});

// สิทธิ์: super_admin เท่านั้น — กำหนดชุด permission ของ role ทั้งชุด (ผูก/ถอนเฉพาะที่ต่างจากเดิม)
adminRolesRouter.put('/admin/role-permissions/roles/:code/permissions', requireAuth, async (req, res) => {
  const { code } = roleParams.parse(req.params);
  const result = await setRolePermissions(req.user!, code, permissionsBody.parse(req.body));
  res.json({ ...result, ...(await getRoleAdminOverview(req.user!)) });
});
