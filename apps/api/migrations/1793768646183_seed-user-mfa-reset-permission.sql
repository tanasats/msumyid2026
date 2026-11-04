-- Up Migration

-- permission รีเซ็ต MFA ของผู้ใช้อื่น (ทำอุปกรณ์หาย/รหัสกู้คืนหมด) — ยืนยันกับผู้ใช้ 2026-11-04
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
INSERT INTO permissions (code, description_th) VALUES
  ('user_mfa:reset', 'รีเซ็ตการยืนยันตัวตนสองขั้นตอน (MFA) ของผู้ใช้อื่น')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code = 'user_mfa:reset';
