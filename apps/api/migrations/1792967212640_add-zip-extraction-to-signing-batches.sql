-- Up Migration

-- ลงนามหลายไฟล์ด้วย ZIP (docs/design/document-signing.md ระยะ D3)
-- ชุดแบบ zip เริ่มที่สถานะ extracting: worker แตก ZIP (อ่านจาก storage ทีละช่วง) สร้างงานต่อ PDF แล้วเปลี่ยนเป็น processing
ALTER TABLE signing_batches
  -- ไฟล์ ZIP ต้นฉบับ (NULL = ชุดไฟล์เดียว ซึ่งต้นฉบับอยู่ที่ signing_jobs.source_file_id)
  ADD COLUMN source_file_id uuid REFERENCES files (id),
  -- รายการใน ZIP ที่ข้าม [{ "name": ..., "reason": ... }] (ไม่ใช่ PDF, ZIP ซ้อน, path แปลก ฯลฯ) — แสดงให้ผู้ใช้เห็น
  ADD COLUMN skipped_entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- เหตุผลที่ทั้งชุดล้มเหลว (เช่น ZIP เสีย, เกินจำนวน/ขนาด, บัญชีถูกปิดก่อนแตกไฟล์) — แปลเป็นข้อความไทยใน signing-service
  ADD COLUMN error_code text,
  -- การแตก ZIP: ลองใหม่เมื่อ storage ล่ม (เลื่อนเวลา) และคืนเข้าคิวเมื่อ worker ตายกลางทาง (started_at ค้างนาน)
  ADD COLUMN extract_attempts integer NOT NULL DEFAULT 0 CHECK (extract_attempts >= 0),
  ADD COLUMN extract_run_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN extract_started_at timestamptz;

ALTER TABLE signing_batches DROP CONSTRAINT signing_batches_status_check;
ALTER TABLE signing_batches ADD CONSTRAINT signing_batches_status_check
  CHECK (status IN ('extracting', 'processing', 'completed', 'failed'));
ALTER TABLE signing_batches ADD CONSTRAINT signing_batches_zip_source_check
  CHECK (source <> 'zip' OR source_file_id IS NOT NULL);

-- คิวแตก ZIP ของ worker (partial index เล็ก เพราะชุดส่วนใหญ่แตกเสร็จแล้ว)
CREATE INDEX signing_batches_extracting_idx ON signing_batches (extract_run_after) WHERE status = 'extracting';

-- Down Migration

DROP INDEX IF EXISTS signing_batches_extracting_idx;
ALTER TABLE signing_batches DROP CONSTRAINT IF EXISTS signing_batches_zip_source_check;
-- dev เท่านั้น: ชุดที่ยังแตกไม่เสร็จนับเป็นล้มเหลว เพื่อคืน CHECK เดิมได้
UPDATE signing_batches SET status = 'failed' WHERE status = 'extracting';
ALTER TABLE signing_batches DROP CONSTRAINT signing_batches_status_check;
ALTER TABLE signing_batches ADD CONSTRAINT signing_batches_status_check
  CHECK (status IN ('processing', 'completed', 'failed'));
ALTER TABLE signing_batches
  DROP COLUMN IF EXISTS extract_started_at,
  DROP COLUMN IF EXISTS extract_run_after,
  DROP COLUMN IF EXISTS extract_attempts,
  DROP COLUMN IF EXISTS error_code,
  DROP COLUMN IF EXISTS skipped_entries,
  DROP COLUMN IF EXISTS source_file_id;
