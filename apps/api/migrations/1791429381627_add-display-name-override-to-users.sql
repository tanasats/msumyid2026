-- Up Migration

-- ชื่อแสดงที่ผู้ดูแลกำหนดเอง (NULL = ไม่กำหนด ใช้ชื่อจาก ERP/Google ตามเดิม)
-- display_name = COALESCE(display_name_override, ชื่อจาก ERP, ชื่อจาก Google) — ค่านี้มาก่อนเสมอ ERP จึงไม่ทับ
ALTER TABLE users ADD COLUMN display_name_override text
  CHECK (display_name_override IS NULL OR btrim(display_name_override) <> '');

-- Down Migration

ALTER TABLE users DROP COLUMN IF EXISTS display_name_override;
