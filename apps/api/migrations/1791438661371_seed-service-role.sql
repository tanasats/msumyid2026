-- Up Migration

-- role ประเภทบัญชีหน่วยงาน — ระบบให้เมื่ออนุมัติบัญชี (แก้ด้วยมือไม่ได้) ยังไม่ผูก permission
-- ON CONFLICT DO NOTHING ทำให้รันซ้ำได้และไม่ทับค่าที่แก้ภายหลัง
INSERT INTO roles (code, name_th, is_system, is_privileged) VALUES
  ('service', 'บัญชีหน่วยงาน', true, false)
ON CONFLICT (code) DO NOTHING;

-- Down Migration

-- role ระบบถูก trigger กันลบ จึงปิด trigger ชั่วคราวเฉพาะตอนย้อน migration นี้
-- ถ้าเคยให้ role นี้แล้ว (user_roles หรือ role_change_logs อ้างอยู่) การลบจะล้มเพราะ foreign key (ตั้งใจ — log ลบไม่ได้)
ALTER TABLE roles DISABLE TRIGGER trg_roles_protect_system;
DELETE FROM roles WHERE code = 'service';
ALTER TABLE roles ENABLE TRIGGER trg_roles_protect_system;
