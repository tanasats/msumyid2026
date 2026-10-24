-- Up Migration

-- permission ส่งคำขอใบรับรองประจำตัวแบบรออนุมัติ (ยืนยันกับผู้ใช้ 2026-10-24)
-- คู่กับ certificate:request (สร้างเองได้ทันที) — super_admin เลือกให้แต่ละ role ได้ที่หน้านโยบายอายุใบรับรอง
-- ยังไม่ผูกกับ role ใด จึงใช้ได้เฉพาะ super_admin จนกว่าจะผูก
INSERT INTO permissions (code, description_th) VALUES
  ('certificate:apply', 'ส่งคำขอใบรับรองประจำตัว (รออนุมัติ)')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code = 'certificate:apply';
