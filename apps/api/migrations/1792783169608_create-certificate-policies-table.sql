-- Up Migration

-- นโยบายอายุใบรับรอง (แก้ได้ด้วย certificate_policy:manage) — ตารางนี้มีได้แถวเดียว (id = true)
-- signer ยังจำกัดเพดานด้วย CERT_VALIDITY_DAYS และอายุของ CA เสมอ
CREATE TABLE certificate_policies (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- days = อายุเป็นจำนวนวันนับจากวันที่ออก, fixed_date = หมดอายุวันที่กำหนดของทุกปี (เช่น 31 ธ.ค.)
  primary_mode            text NOT NULL DEFAULT 'days' CHECK (primary_mode IN ('days', 'fixed_date')),
  primary_days            integer NOT NULL DEFAULT 365 CHECK (primary_days BETWEEN 1 AND 825),
  primary_expiry_month    integer NOT NULL DEFAULT 12 CHECK (primary_expiry_month BETWEEN 1 AND 12),
  -- วันที่ 1-28 ใช้ได้ทุกเดือน 29-31 ตรวจกับเดือนใน service (กุมภาพันธ์ใช้ได้ถึง 28)
  primary_expiry_day      integer NOT NULL DEFAULT 31 CHECK (primary_expiry_day BETWEEN 1 AND 31),
  -- โหมด fixed_date: ถ้าเหลือน้อยกว่าเท่านี้ ให้หมดอายุวันเดียวกันของปีถัดไป (กันขอปลายปีแล้วได้ใบไม่กี่วัน)
  primary_min_days        integer NOT NULL DEFAULT 60 CHECK (primary_min_days BETWEEN 0 AND 365),
  -- ขอใบหลักใหม่ได้เมื่อใบหลักที่ใช้งานอยู่เหลือไม่เกินเท่านี้ (ใบเดิมใช้ต่อจนหมดอายุ)
  renewal_window_days     integer NOT NULL DEFAULT 30 CHECK (renewal_window_days BETWEEN 0 AND 365),
  -- ใบเสริม: อายุสูงสุดที่ขอ/อนุมัติได้ และจำนวนใบเสริมที่ใช้งานอยู่พร้อมกันต่อคน
  supplementary_max_days  integer NOT NULL DEFAULT 90 CHECK (supplementary_max_days BETWEEN 1 AND 825),
  supplementary_max_active integer NOT NULL DEFAULT 3 CHECK (supplementary_max_active BETWEEN 0 AND 20),
  updated_by              uuid REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_certificate_policies_updated_at
  BEFORE UPDATE ON certificate_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ค่าเริ่มต้นทำงานเหมือนก่อนมีนโยบาย (ใบหลักอายุ 365 วัน)
INSERT INTO certificate_policies (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ประวัติการแก้นโยบาย (append-only) เก็บค่าก่อน/หลังทั้งชุด
CREATE TABLE certificate_policy_logs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_id    uuid NOT NULL REFERENCES users (id),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX certificate_policy_logs_created_at_idx ON certificate_policy_logs (created_at DESC);

CREATE TRIGGER trg_certificate_policy_logs_append_only
  BEFORE UPDATE OR DELETE ON certificate_policy_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_certificate_policy_logs_no_truncate
  BEFORE TRUNCATE ON certificate_policy_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS certificate_policy_logs;
DROP TABLE IF EXISTS certificate_policies;
