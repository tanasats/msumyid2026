-- Up Migration

-- ชื่อที่ระบบใช้แสดงทุกที่ (users.name ยังเก็บชื่อจาก Google ตามเดิม)
-- บุคลากร = ชื่อ-นามสกุลไทยจาก ERP-HR (ไม่มีคำนำหน้า), นิสิต/บุคลากรภายนอก = ชื่อจาก Google
-- ขั้นตอน: เพิ่มแบบ NULL ได้ → เติมค่าแถวเดิมจาก name → แล้วจึงบังคับ NOT NULL
ALTER TABLE users ADD COLUMN display_name text;
UPDATE users SET display_name = name WHERE display_name IS NULL;
ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;

-- Down Migration

ALTER TABLE users DROP COLUMN IF EXISTS display_name;
