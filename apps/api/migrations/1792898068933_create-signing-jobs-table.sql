-- Up Migration

-- งานลงนามทีละไฟล์ (คิวของ worker) — docs/design/document-signing.md
-- worker หยิบงาน pending ด้วย FOR UPDATE SKIP LOCKED จึงรันหลายตัวพร้อมกันได้โดยไม่หยิบงานซ้ำ
CREATE TABLE signing_jobs (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  batch_id         uuid NOT NULL REFERENCES signing_batches (id),
  source_file_id   uuid NOT NULL REFERENCES files (id),
  -- ไฟล์ที่ลงนามแล้ว (files.purpose = 'signing_result') — NULL จนกว่าจะลงนามสำเร็จ
  signed_file_id   uuid REFERENCES files (id),
  -- ชื่อไฟล์ต้นฉบับ (ข้อมูลส่วนบุคคลได้ — ลบบัญชีแล้วล้าง) แยกจาก files เพราะไฟล์ใน ZIP (D3) ไม่มีแถว files ของตัวเอง
  original_name    text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 255),
  -- pending = รอคิว, signing = worker กำลังทำ, signed = สำเร็จ, failed = ล้มเหลว (ดู error_code)
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signing', 'signed', 'failed')),
  -- รหัสเหตุผลที่ล้มเหลว (แปลเป็นข้อความไทยใน signing-service) — ไม่เก็บรายละเอียดภายใน
  error_code       text,
  -- SHA-256 ของไฟล์ก่อน/หลังลงนาม (เก็บถาวรใน certificate_audit_logs ด้วย)
  document_sha256  text CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  signed_sha256    text CHECK (signed_sha256 ~ '^[0-9a-f]{64}$'),
  -- จำนวนครั้งที่ worker หยิบไปทำ — ลองใหม่เฉพาะความล้มเหลวชั่วคราว (TSA/signer/storage ล่ม) ไม่เกินที่กำหนด
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- เวลาที่หยิบได้ (เลื่อนออกไปเมื่อล้มเหลวชั่วคราว)
  run_after        timestamptz NOT NULL DEFAULT now(),
  -- เวลาที่ worker เริ่มทำครั้งล่าสุด — งาน signing ที่ค้างนานเกิน (worker ตาย) ถูกคืนเข้าคิว
  started_at       timestamptz,
  signed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signing_jobs_signed_check CHECK (status <> 'signed' OR (signed_file_id IS NOT NULL AND signed_at IS NOT NULL)),
  CONSTRAINT signing_jobs_failed_check CHECK (status <> 'failed' OR error_code IS NOT NULL)
);

-- คิวของ worker: partial index เล็ก เพราะงานส่วนใหญ่จบไปแล้ว
CREATE INDEX signing_jobs_pending_idx ON signing_jobs (run_after) WHERE status = 'pending';
-- งานที่ค้างสถานะ signing (คืนเข้าคิวเมื่อ worker ตายกลางทาง)
CREATE INDEX signing_jobs_signing_idx ON signing_jobs (started_at) WHERE status = 'signing';
CREATE INDEX signing_jobs_batch_id_idx ON signing_jobs (batch_id);

CREATE TRIGGER trg_signing_jobs_set_updated_at
  BEFORE UPDATE ON signing_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS signing_jobs;
