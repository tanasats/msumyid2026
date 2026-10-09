-- Up Migration

-- permission ของระบบจัดการบัญชีผู้ใช้ (ยืนยันกับผู้ใช้ 2026-10-08) — ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin
-- ON CONFLICT DO NOTHING: รันซ้ำได้และไม่ทับคำอธิบายที่แก้ภายหลัง
INSERT INTO permissions (code, description_th) VALUES
  ('user:read',       'ดูรายชื่อ ค้นหา และดูรายละเอียดผู้ใช้'),
  ('user:create',     'ลงทะเบียนผู้ใช้ล่วงหน้าด้วยอีเมล'),
  ('user:update',     'แก้ไขข้อมูลผู้ใช้'),
  ('user:deactivate', 'ปิด/เปิดบัญชีผู้ใช้'),
  ('user:delete',     'ลบบัญชีและข้อมูลส่วนบุคคลของผู้ใช้')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions
WHERE code IN ('user:read', 'user:create', 'user:update', 'user:deactivate', 'user:delete');
