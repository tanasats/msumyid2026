import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import {
  activateUser,
  approveUser,
  deactivateUser,
  deleteUser,
  getUserDetail,
  grantRole,
  listOrgUnits,
  listRolesForActor,
  rejectUser,
  revokeRole,
  searchUsers,
  updateUser,
} from '../services/user-admin-service.js';

export const adminUsersRouter = Router();

const PAGE_SIZE = 20;

// query ที่ไม่ส่งมา → null (repository ใช้ null = ไม่กรอง)
const nullable = <T extends z.ZodType>(schema: T) => schema.optional().transform((v) => v ?? null);

const listQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || null),
  status: nullable(z.enum(['active', 'pending', 'rejected', 'inactive'])),
  accountType: nullable(z.enum(['student', 'staff', 'external'])),
  role: nullable(z.string().regex(/^[a-z0-9_]+$/)),
  cursor: nullable(z.uuid()),
});

const userIdParams = z.object({ id: z.uuid() });
const userRoleParams = z.object({ id: z.uuid(), roleCode: z.string().regex(/^[a-z0-9_]+$/) });

// เหตุผลบังคับกรอก (บันทึกใน log) / ไม่บังคับ (อนุมัติบัญชี)
const reasonBody = z.object({ reason: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500) });
const optionalReasonBody = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
});

// สิทธิ์: user:read — รายการผู้ใช้ ค้นหา และกรอง (แบ่งหน้าแบบ cursor)
adminUsersRouter.get('/admin/users', requirePermission(PERMISSIONS.USER_READ), async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const result = await searchUsers({
    q: query.q,
    status: query.status,
    accountType: query.accountType,
    roleCode: query.role,
    afterId: query.cursor,
    limit: PAGE_SIZE,
  });
  res.json(result);
});

// สิทธิ์: user:read — role ทั้งหมด พร้อมบอกว่าผู้เรียกให้/ถอนได้หรือไม่ (ใช้แสดงตัวเลือกบนหน้าจอ)
adminUsersRouter.get('/admin/roles', requirePermission(PERMISSIONS.USER_READ), async (req, res) => {
  const roles = await listRolesForActor(req.user!);
  res.json({ roles });
});

// สิทธิ์: user:read — รายละเอียดผู้ใช้ + ข้อมูลบุคลากร + ประวัติ
adminUsersRouter.get('/admin/users/:id', requirePermission(PERMISSIONS.USER_READ), async (req, res) => {
  const { id } = userIdParams.parse(req.params);
  res.json(await getUserDetail(req.user!, id));
});

// สิทธิ์: user:deactivate — ปิดบัญชี (เพิกถอน session ทันที)
adminUsersRouter.post(
  '/admin/users/:id/deactivate',
  requirePermission(PERMISSIONS.USER_DEACTIVATE),
  async (req, res) => {
    const { id } = userIdParams.parse(req.params);
    const { reason } = reasonBody.parse(req.body);
    await deactivateUser(req.user!, id, reason);
    res.status(204).end();
  },
);

// สิทธิ์: user:deactivate — เปิดบัญชีคืน
adminUsersRouter.post(
  '/admin/users/:id/activate',
  requirePermission(PERMISSIONS.USER_DEACTIVATE),
  async (req, res) => {
    const { id } = userIdParams.parse(req.params);
    const { reason } = reasonBody.parse(req.body);
    await activateUser(req.user!, id, reason);
    res.status(204).end();
  },
);

// สิทธิ์: user:approve — อนุมัติบัญชีบุคลากรภายนอก
adminUsersRouter.post('/admin/users/:id/approve', requirePermission(PERMISSIONS.USER_APPROVE), async (req, res) => {
  const { id } = userIdParams.parse(req.params);
  const { reason } = optionalReasonBody.parse(req.body ?? {});
  await approveUser(req.user!, id, reason);
  res.status(204).end();
});

// สิทธิ์: user:approve — ปฏิเสธบัญชีที่รออนุมัติ
adminUsersRouter.post('/admin/users/:id/reject', requirePermission(PERMISSIONS.USER_APPROVE), async (req, res) => {
  const { id } = userIdParams.parse(req.params);
  const { reason } = reasonBody.parse(req.body);
  await rejectUser(req.user!, id, reason);
  res.status(204).end();
});

// สิทธิ์: user_role:assign (role สิทธิ์สูงต้องเป็น super_admin — ตรวจใน canGrantRole)
adminUsersRouter.post(
  '/admin/users/:id/roles/:roleCode',
  requirePermission(PERMISSIONS.USER_ROLE_ASSIGN),
  async (req, res) => {
    const { id, roleCode } = userRoleParams.parse(req.params);
    const { reason } = reasonBody.parse(req.body);
    await grantRole(req.user!, id, roleCode, reason);
    res.status(204).end();
  },
);

// สิทธิ์: user_role:assign — ถอน role (เหตุผลส่งใน body)
adminUsersRouter.delete(
  '/admin/users/:id/roles/:roleCode',
  requirePermission(PERMISSIONS.USER_ROLE_ASSIGN),
  async (req, res) => {
    const { id, roleCode } = userRoleParams.parse(req.params);
    const { reason } = reasonBody.parse(req.body);
    await revokeRole(req.user!, id, roleCode, reason);
    res.status(204).end();
  },
);

// สิทธิ์: user:read — หน่วยงานที่ใช้งานอยู่ (ตัวเลือกในฟอร์มแก้ไขผู้ใช้)
adminUsersRouter.get('/admin/org-units', requirePermission(PERMISSIONS.USER_READ), async (_req, res) => {
  res.json({ orgUnits: await listOrgUnits() });
});

// ช่องที่ไม่ส่งมา = ไม่แก้, null = ล้างค่า, ชื่อแสดงเป็นข้อความว่าง = ล้างค่า (กลับไปใช้ชื่อจาก ERP/Google)
const updateBody = z.object({
  displayNameOverride: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v)),
  accountType: z.enum(['student', 'staff', 'external']).optional(),
  orgUnitId: z.uuid().nullable().optional(),
  reason: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500),
});

// สิทธิ์: user:update — แก้ไขชื่อแสดง ประเภทบัญชี หน่วยงาน
adminUsersRouter.patch('/admin/users/:id', requirePermission(PERMISSIONS.USER_UPDATE), async (req, res) => {
  const { id } = userIdParams.parse(req.params);
  const { reason, ...input } = updateBody.parse(req.body);
  await updateUser(req.user!, id, input, reason);
  res.status(204).end();
});

const deleteBody = z.object({
  confirmEmail: z.string().trim().min(1, 'กรุณาพิมพ์อีเมลเพื่อยืนยัน').max(320),
  reason: z.string().trim().min(1, 'กรุณาระบุเหตุผล').max(500),
});

// สิทธิ์: user:delete — ลบบัญชีและข้อมูลส่วนบุคคล (ย้อนกลับไม่ได้ ต้องพิมพ์อีเมลยืนยัน)
adminUsersRouter.delete('/admin/users/:id', requirePermission(PERMISSIONS.USER_DELETE), async (req, res) => {
  const { id } = userIdParams.parse(req.params);
  const { confirmEmail, reason } = deleteBody.parse(req.body);
  await deleteUser(req.user!, id, confirmEmail, reason);
  res.status(204).end();
});
