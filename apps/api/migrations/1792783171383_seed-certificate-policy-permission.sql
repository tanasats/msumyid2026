-- Up Migration

-- permission กำหนดนโยบายอายุใบรับรอง (ยืนยันกับผู้ใช้ 2026-10-24)
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
INSERT INTO permissions (code, description_th) VALUES
  ('certificate_policy:manage', 'กำหนดนโยบายอายุใบรับรองหลักและเพดานของใบรับรองเสริม')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code = 'certificate_policy:manage';
