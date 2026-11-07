-- Up Migration

-- permission จับคู่หน่วยงาน ERP กับหน่วยงานในระบบ (หน้า /admin/org-units) — ยืนยันกับผู้ใช้ 2026-11-07
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
INSERT INTO permissions (code, description_th) VALUES
  ('org_unit:manage', 'จับคู่หน่วยงาน ERP กับหน่วยงานในระบบ')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code = 'org_unit:manage';
