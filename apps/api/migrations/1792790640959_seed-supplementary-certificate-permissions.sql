-- Up Migration

-- permission ของใบรับรองเสริม (ยืนยันกับผู้ใช้ 2026-10-24)
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
INSERT INTO permissions (code, description_th) VALUES
  ('supplementary_certificate:request', 'ขอ รับ ดาวน์โหลด และเพิกถอนใบรับรองเสริมของตัวเอง'),
  ('certificate:approve',               'ดู อนุมัติ และปฏิเสธคำขอใบรับรองเสริมของผู้อื่น')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code IN ('supplementary_certificate:request', 'certificate:approve');
