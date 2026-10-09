-- Up Migration

-- permission ของระบบใบรับรองและการลงนามเอกสาร (ยืนยันกับผู้ใช้ 2026-10-08)
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
-- ON CONFLICT DO NOTHING: รันซ้ำได้และไม่ทับคำอธิบายที่แก้ภายหลัง
INSERT INTO permissions (code, description_th) VALUES
  ('certificate:request', 'ขอ ดาวน์โหลด และเพิกถอนใบรับรองของตัวเอง'),
  ('certificate:read',    'ดูใบรับรองของผู้อื่น'),
  ('certificate:revoke',  'เพิกถอนใบรับรองของผู้อื่น'),
  ('document:sign',       'ลงนามเอกสารด้วยใบรับรองของตัวเอง')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions
WHERE code IN ('certificate:request', 'certificate:read', 'certificate:revoke', 'document:sign');
