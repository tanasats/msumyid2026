# ระบบจัดการบัญชีผู้ใช้

ออกแบบและตัดสินใจร่วมกับผู้พัฒนาเมื่อ 2026-10-08

## การตัดสินใจ

| เรื่อง | ข้อสรุป |
|---|---|
| Permission | แยกละเอียด: `user:read`, `user:create`, `user:update`, `user:deactivate`, `user:delete` (+ `user:approve`, `user_role:assign` เดิม) — ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ `super_admin` |
| ลบบัญชี | **ลบข้อมูลส่วนบุคคล** (anonymize) ไม่ใช่ลบแถว — การ "ปิดบัญชี" ทำหน้าที่แทน soft delete อยู่แล้ว |
| เพิ่มผู้ใช้ | ลงทะเบียนล่วงหน้าด้วยอีเมล แล้วผูก `google_sub` ตอน login ครั้งแรก (แก้ขั้นตอน login — อนุมัติแล้ว) |
| ชื่อแสดง | ผู้ดูแลแก้ได้ และต้องไม่ถูก ERP ทับ |
| ประเภทบัญชี | ผู้ดูแลแก้ได้ |

## กฎ (ตรวจที่ API เสมอ)

- ทุก endpoint ตรวจ permission ด้วย `requirePermission` — ห้ามเช็คชื่อ role
- ห้ามจัดการบัญชีหรือ role ของตัวเอง
- ผู้ใช้ที่ถือ role สิทธิ์สูง (`is_privileged`) จัดการได้เฉพาะ `super_admin` (`canManageUser`)
- role สิทธิ์สูงให้/ถอนได้เฉพาะ `super_admin`, role อื่นต้องมี `user_role:assign` (`canGrantRole`)
- role ประเภทบัญชี (`user`, `student`, `staff`, `external`) ระบบจัดการเอง แก้ด้วยมือไม่ได้
- ต้องมี `super_admin` ที่ใช้งานได้อย่างน้อย 1 คนเสมอ — ล็อกรายชื่อ `super_admin` ทั้งหมดก่อนล็อกผู้ใช้เป้าหมาย (ลำดับล็อกเดียวกันทุก transaction กัน deadlock)
- ทุกการเปลี่ยนแปลงเขียน `user_audit_logs` หรือ `role_change_logs` ใน transaction เดียวกัน และ log แก้/ลบไม่ได้
- **PDPA:** `user_audit_logs.changes` ห้ามเก็บค่าข้อมูลส่วนบุคคล (ชื่อ, อีเมล) เพราะ log ลบไม่ได้ — บันทึกแค่ว่าช่องนั้น "เปลี่ยน"

## ระยะการพัฒนา

| ระยะ | งาน | สถานะ |
|---|---|---|
| 1 | รายการ/ค้นหา/รายละเอียด, ปิด/เปิดบัญชี, ให้/ถอน role, อนุมัติ/ไม่อนุมัติบุคลากรภายนอก, audit log | เสร็จ |
| 2 | แก้ไขข้อมูล: ชื่อแสดง (`display_name_override`), หน่วยงาน (เฉพาะนิสิต/บุคลากรภายนอก), ประเภทบัญชี | เสร็จ |
| 3 | ลบข้อมูลส่วนบุคคล (ต้องพิมพ์อีเมลยืนยัน) | เสร็จ |
| 4 | ลงทะเบียนล่วงหน้าด้วยอีเมล + ผูกบัญชี Google ตอน login | ยังไม่ทำ |
| แยก | บัญชีแบบรหัสผ่าน (ต้องมีระบบอีเมลก่อน) | ยังไม่ทำ |

## API

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/users?q=&status=&accountType=&role=&cursor=` | `user:read` |
| GET | `/admin/roles` | `user:read` |
| GET | `/admin/users/:id` | `user:read` |
| POST | `/admin/users/:id/deactivate` · `/activate` (บังคับเหตุผล) | `user:deactivate` |
| POST | `/admin/users/:id/approve` (เหตุผลไม่บังคับ) · `/reject` (บังคับ) | `user:approve` |
| POST · DELETE | `/admin/users/:id/roles/:roleCode` (บังคับเหตุผล) | `user_role:assign` |
| PATCH | `/admin/users/:id` (`displayNameOverride`, `accountType`, `orgUnitId` + บังคับเหตุผล) | `user:update` |
| GET | `/admin/org-units` | `user:read` |
| DELETE | `/admin/users/:id` (`confirmEmail` + บังคับเหตุผล) — ลบข้อมูลส่วนบุคคล ย้อนกลับไม่ได้ | `user:delete` |

รายการผู้ใช้แบ่งหน้าแบบ keyset ด้วย `id` (uuidv7 เรียงตามเวลาสร้าง) และค้นหาบางส่วนด้วย index `pg_trgm`
