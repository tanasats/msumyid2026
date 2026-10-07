-- Up Migration

-- role ตั้งต้น — ON CONFLICT DO NOTHING ทำให้รันซ้ำได้และไม่ทับค่าที่แก้ภายหลัง
INSERT INTO roles (code, name_th, is_system, is_privileged) VALUES
  ('user',        'ผู้ใช้งานทั่วไป',   true,  false),
  ('super_admin', 'ผู้ดูแลระบบสูงสุด', true,  true),
  ('student',     'นิสิต',            true,  false),
  ('staff',       'บุคลากร',          true,  false),
  ('external',    'บุคลากรภายนอก',    true,  false),
  ('admin',       'ผู้ดูแลระบบ',       false, true)
ON CONFLICT (code) DO NOTHING;

-- permission ที่ลงทะเบียน — ยังไม่ผูกกับ role ใด (ใช้ได้เฉพาะ super_admin จนกว่าจะผูก)
INSERT INTO permissions (code, description_th) VALUES
  ('user_role:assign', 'ให้/ถอน role ที่ไม่ใช่ role สิทธิ์สูงแก่ผู้ใช้อื่น'),
  ('user:approve',     'อนุมัติ/ปฏิเสธบัญชีบุคลากรภายนอกที่รออนุมัติ')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code IN ('user_role:assign', 'user:approve');
-- role ระบบถูก trigger กันลบ จึงปิด trigger ชั่วคราวเฉพาะตอนย้อน migration นี้
ALTER TABLE roles DISABLE TRIGGER trg_roles_protect_system;
DELETE FROM roles WHERE code IN ('user', 'super_admin', 'student', 'staff', 'external', 'admin');
ALTER TABLE roles ENABLE TRIGGER trg_roles_protect_system;
