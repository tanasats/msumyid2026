-- Up Migration

-- ไฟล์ใน storage (Garage) — CLAUDE.md หัวข้อ 11, docs/design/document-signing.md
-- object_key เป็น UUID (ไม่ใช้ชื่อไฟล์ต้นฉบับ) ชื่อเดิมเก็บที่ original_name
-- ไฟล์ของการลงนามเอกสารมีอายุ (expires_at = 7 วัน) แล้ว job ลบ object และตั้ง deleted_at ให้ตรงกัน
CREATE TABLE files (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  bucket         text NOT NULL,
  object_key     text NOT NULL,
  -- ใช้ทำอะไร — กำหนดชนิด/ขนาดที่รับ (allowlist ใน file-service)
  purpose        text NOT NULL CHECK (purpose IN ('signing_source', 'signing_result', 'signature_image')),
  -- ชื่อไฟล์ต้นฉบับ (ข้อมูลส่วนบุคคลได้ — ลบบัญชีแล้วล้าง)
  original_name  text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  mime_type      text NOT NULL,
  size           bigint NOT NULL CHECK (size >= 0),
  -- คำนวณเมื่ออ่านไฟล์จริง (เช่น ตอนลงนาม) — NULL = ยังไม่ได้คำนวณ
  sha256         text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- pending = ออก URL อัปโหลดแล้วยังไม่ยืนยัน, uploaded = ตรวจขนาด/ชนิดใน storage แล้ว
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded')),
  uploaded_by    uuid NOT NULL REFERENCES users (id),
  expires_at     timestamptz,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT files_object_unique UNIQUE (bucket, object_key)
);

-- job ลบไฟล์หมดอายุ: เฉพาะที่ยังไม่ลบ (partial index เล็ก เพราะไฟล์ส่วนใหญ่ถูกลบไปแล้ว)
CREATE INDEX files_expires_at_idx ON files (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
CREATE INDEX files_uploaded_by_idx ON files (uploaded_by, created_at DESC);

CREATE TRIGGER trg_files_set_updated_at
  BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS files;
