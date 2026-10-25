-- Up Migration

-- ภาพลายเซ็นของผู้ใช้ (docs/design/document-signing.md ระยะ D2) — 1 ภาพต่อผู้ใช้ ตั้งครั้งเดียวใช้ซ้ำทุกการลงนาม
-- ตัวไฟล์ (PNG) อยู่ใน storage ผ่านตาราง files (purpose = 'signature_image') เก็บจนผู้ใช้เปลี่ยน/ลบภาพหรือลบบัญชี (ยืนยัน 2026-10-25)
-- เปลี่ยนภาพ = แทนแถวเดิม และไฟล์เดิมหมดอายุทันที (job ลบ object)
CREATE TABLE signature_images (
  user_id     uuid PRIMARY KEY REFERENCES users (id),
  file_id     uuid NOT NULL REFERENCES files (id),
  -- ขนาดภาพ (pixel) อ่านจาก IHDR ของ PNG ตอนตั้งภาพ — หน้าเว็บใช้คำนวณสัดส่วนกรอบลายเซ็น
  width       integer NOT NULL CHECK (width > 0),
  height      integer NOT NULL CHECK (height > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_signature_images_set_updated_at
  BEFORE UPDATE ON signature_images
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS signature_images;
