-- Up Migration

-- ชุดการลงนามเอกสาร (docs/design/document-signing.md) — 1 ครั้งที่ผู้ใช้กดลงนาม (ใส่ PIN ครั้งเดียวต่อชุด)
-- D1 = ไฟล์เดียว (source = 'single') แบบมองไม่เห็น ส่วน ZIP (D3) ใช้ตารางเดียวกัน — ไฟล์แต่ละไฟล์อยู่ใน signing_jobs
CREATE TABLE signing_batches (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES users (id),
  certificate_id  uuid NOT NULL REFERENCES certificates (id),
  source          text NOT NULL CHECK (source IN ('single', 'zip')),
  -- ตำแหน่งภาพลายเซ็น (D2): visible, page, x, y, w, h เป็นสัดส่วนของหน้า, showText — D1 มีแค่ {"visible": false}
  appearance      jsonb NOT NULL DEFAULT '{"visible": false}'::jsonb,
  -- ล็อกเอกสาร: certification signature + DocMDP P=1
  lock_document   boolean NOT NULL DEFAULT false,
  -- processing = ยังมีไฟล์รอ/กำลังลงนาม, completed = จบแล้วและลงนามได้อย่างน้อย 1 ไฟล์, failed = ทุกไฟล์ล้มเหลว
  status          text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  -- ไฟล์ของชุดเก็บ 7 วัน (เท่ากับ files.expires_at) — หลังจากนั้นเหลือแค่ประวัติ
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- รายการชุดของผู้ใช้ ล่าสุดก่อน
CREATE INDEX signing_batches_user_id_idx ON signing_batches (user_id, created_at DESC);
CREATE INDEX signing_batches_certificate_id_idx ON signing_batches (certificate_id);

CREATE TRIGGER trg_signing_batches_set_updated_at
  BEFORE UPDATE ON signing_batches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS signing_batches;
