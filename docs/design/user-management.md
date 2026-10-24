# ระบบจัดการบัญชีผู้ใช้

ออกแบบและตัดสินใจร่วมกับผู้พัฒนาเมื่อ 2026-10-08

## การตัดสินใจ

| เรื่อง | ข้อสรุป |
|---|---|
| Permission | แยกละเอียด: `user:read`, `user:create`, `user:update`, `user:deactivate`, `user:delete` (+ `user:approve`, `user_role:assign` เดิม) — ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ `super_admin` |
| ลบบัญชี | **ลบข้อมูลส่วนบุคคล** (anonymize) ไม่ใช่ลบแถว — การ "ปิดบัญชี" ทำหน้าที่แทน soft delete อยู่แล้ว |
| ใบรับรองเมื่อปิด/ลบ/หมดอายุ | เพิกถอนใบที่ใช้งานอยู่อัตโนมัติ (`cessationOfOperation`) ใน transaction เดียวกัน แล้วออก CRL — เปิดบัญชีคืนไม่ย้อนการเพิกถอน; ลบบัญชีลบชื่อ/อีเมล/ตัวใบ/key สำรองในใบด้วย (คง serial และการเพิกถอนให้ CRL) — ดู `docs/design/certificates.md` |
| เพิ่มผู้ใช้ | ลงทะเบียนล่วงหน้าด้วยอีเมล แล้วผูก `google_sub` ตอน login ครั้งแรก (แก้ขั้นตอน login — อนุมัติแล้ว) |
| ชื่อแสดง | ผู้ดูแลแก้ได้ และต้องไม่ถูก ERP ทับ |
| ประเภทบัญชี | ผู้ดูแลแก้ได้ |

## กฎ (ตรวจที่ API เสมอ)

- ทุก endpoint ตรวจ permission ด้วย `requirePermission` — ห้ามเช็คชื่อ role
- ห้ามจัดการบัญชีหรือ role ของตัวเอง — ยกเว้น `super_admin` ที่จัดการได้ทุกอย่างรวมของตัวเอง (ตัดสินใจ 2026-10-24: แก้ข้อมูล, ให้/ถอน role, ปิด/ลบบัญชี, เพิกถอนใบรับรอง, ตัดสินคำขอใบเสริม) แต่กฎ "ต้องเหลือ super_admin อย่างน้อย 1 คน" ยังใช้ และปิด/ลบบัญชีตัวเองต้องพิมพ์อีเมลยืนยัน
- ผู้ใช้ที่ถือ role สิทธิ์สูง (`is_privileged`) จัดการได้เฉพาะ `super_admin` (`canManageUser`)
- role สิทธิ์สูงให้/ถอนได้เฉพาะ `super_admin`, role อื่นต้องมี `user_role:assign` (`canGrantRole`)
- role ประเภทบัญชี (`user`, `student`, `staff`, `external`) ระบบจัดการเอง แก้ด้วยมือไม่ได้
- ต้องมี `super_admin` ที่ใช้งานได้อย่างน้อย 1 คนเสมอ — ล็อกรายชื่อ `super_admin` ทั้งหมดก่อนล็อกผู้ใช้เป้าหมาย (ลำดับล็อกเดียวกันทุก transaction กัน deadlock)
- ทุกการเปลี่ยนแปลงเขียน `user_audit_logs` หรือ `role_change_logs` ใน transaction เดียวกัน และ log แก้/ลบไม่ได้
- **PDPA:** `user_audit_logs.changes` ห้ามเก็บค่าข้อมูลส่วนบุคคล (ชื่อ, อีเมล) เพราะ log ลบไม่ได้ — บันทึกแค่ว่าช่องนั้น "เปลี่ยน"

## บทบาทและสิทธิ์ (ตัดสินใจ 2026-10-24)

- นักพัฒนาประกาศ permission ผ่าน migration ส่วน super_admin สร้างบทบาทและผูก permission ที่หน้า `/admin/roles` (ไม่ต้องแก้ฐานข้อมูลเอง)
- ใช้กฎ `canManageRoles` = super_admin เท่านั้น ไม่ใช้ permission เพราะผู้ถือ permission นั้นจะให้สิทธิ์ตัวเองเพิ่มได้
- `/auth/me` ส่ง `capabilities.manageRoles` ให้เว็บซ่อน/แสดงเมนู — เว็บไม่เช็คชื่อ role เอง
- ยังไม่มีการลบบทบาท: `role_change_logs`/`role_permission_logs` อ้างถึงบทบาทด้วย FK — บทบาทที่เลิกใช้ให้ถอนสิทธิ์และถอนจากผู้ใช้ออกให้หมด

## ระยะการพัฒนา

| ระยะ | งาน | สถานะ |
|---|---|---|
| 1 | รายการ/ค้นหา/รายละเอียด, ปิด/เปิดบัญชี, ให้/ถอน role, อนุมัติ/ไม่อนุมัติบุคลากรภายนอก, audit log | เสร็จ |
| 2 | แก้ไขข้อมูล: ชื่อแสดง (`display_name_override`), หน่วยงาน (เฉพาะนิสิต/บุคลากรภายนอก), ประเภทบัญชี | เสร็จ |
| 3 | ลบข้อมูลส่วนบุคคล (ต้องพิมพ์อีเมลยืนยัน) | เสร็จ |
| 4 | ลงทะเบียนล่วงหน้าด้วยอีเมล + ผูกบัญชี Google ตอน login (โดเมน มมส. ต้องมี `hd` ตรง) | เสร็จ |
| 5 | บัญชีหน่วยงาน (`service`): หน่วยงาน + ผู้รับผิดชอบก่อนอนุมัติ, วันหมดอายุ + ปิดอัตโนมัติ | เสร็จ |
| 6 | บัญชีรอจำแนกประเภท (`unclassified`): บัญชี มมส. ใหม่ที่ ERP ไม่ยืนยัน (ไม่พบ/ล่ม) → รออนุมัติ, ผู้อนุมัติเลือกบุคลากรภายนอกหรือบัญชีหน่วยงาน (แก้ไขข้อมูล → ประเภทบัญชี) ก่อนอนุมัติ, login ครั้งถัดไป ERP พบ → บุคลากรอัตโนมัติ | เสร็จ |
| 7 | หน้าบทบาทและสิทธิ์ `/admin/roles` (super_admin เท่านั้น): สร้างบทบาท, เปลี่ยนชื่อ, กำหนดชุดสิทธิ์ + ประวัติ `role_permission_logs` | เสร็จ |
| แยก | บัญชีแบบรหัสผ่าน (ต้องมีระบบอีเมลก่อน) | ยังไม่ทำ |

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/users?q=&status=&accountType=&role=&cursor=` | `user:read` |
| POST | `/admin/users` (`email`, `name`, `accountType`, `orgUnitId`, `responsibleUserId`, `accountExpiresAt`) — ลงทะเบียนล่วงหน้า อนุมัติไว้แล้ว (บัญชีหน่วยงานบังคับหน่วยงาน + ผู้รับผิดชอบ) | `user:create` |
| GET | `/admin/roles` | `user:read` |
| GET | `/admin/users/:id` | `user:read` |
| POST | `/admin/users/:id/deactivate` · `/activate` (บังคับเหตุผล) | `user:deactivate` |
| POST | `/admin/users/:id/approve` (เหตุผลไม่บังคับ, บัญชีหน่วยงานต้องมีหน่วยงาน + ผู้รับผิดชอบ) · `/reject` (บังคับ) | `user:approve` |
| POST · DELETE | `/admin/users/:id/roles/:roleCode` (บังคับเหตุผล) | `user_role:assign` |
| PATCH | `/admin/users/:id` (`displayNameOverride`, `accountType`, `orgUnitId`, `responsibleUserId`, `accountExpiresAt` + บังคับเหตุผล) | `user:update` |
| GET | `/admin/org-units` | `user:read` |
| DELETE | `/admin/users/:id` (`confirmEmail` + บังคับเหตุผล) — ลบข้อมูลส่วนบุคคล ย้อนกลับไม่ได้ | `user:delete` |
| GET | `/admin/role-permissions` — บทบาททั้งหมด (จำนวนผู้ถือ, สิทธิ์, `hasAllPermissions`) + permission ทั้งหมด + ประวัติ 30 รายการ | super_admin (`canManageRoles`) |
| POST | `/admin/role-permissions/roles` (`code`, `nameTh`, `isPrivileged`, `reason`) — สร้างบทบาท (ไม่ใช่บทบาทระบบ, `isPrivileged` เปลี่ยนภายหลังไม่ได้) | super_admin |
| PATCH | `/admin/role-permissions/roles/:code` (`nameTh`, `reason`) — เปลี่ยนชื่อไทย (รวมบทบาทระบบ, code เปลี่ยนไม่ได้) | super_admin |
| PUT | `/admin/role-permissions/roles/:code/permissions` (`permissions[]`, `reason`) — กำหนดชุดสิทธิ์ทั้งชุด ผูก/ถอนเฉพาะที่ต่าง log ทีละรายการ ล็อกแถว role; `super_admin` = 409 `SUPER_ADMIN_HAS_ALL` | super_admin |

รายการผู้ใช้แบ่งหน้าแบบ keyset ด้วย `id` (uuidv7 เรียงตามเวลาสร้าง) และค้นหาบางส่วนด้วย index `pg_trgm`
