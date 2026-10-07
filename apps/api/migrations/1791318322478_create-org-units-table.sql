-- Up Migration

-- หน่วยงานของมหาวิทยาลัย (คณะ/สำนัก/กอง) ใช้รหัส 2 หลักแบบเดียวกับหลักที่ 5-6 ของรหัสนิสิต
-- รหัสของ ERP (12 หลัก) เป็นคนละชุด ห้ามเทียบตรง ๆ — ผูกผ่าน erp_org_units (ขั้น 2.4)
CREATE TABLE org_units (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[0-9]{2}$'),
  name_th     text NOT NULL,
  -- 'A' = หน่วยงานวิชาการ (คณะ/วิทยาลัย/โรงเรียนสาธิต), NULL = หน่วยงานสนับสนุน
  category    text CHECK (category IN ('A')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_org_units_set_updated_at
  BEFORE UPDATE ON org_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS org_units;
