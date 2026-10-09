-- Up Migration

-- หน่วยงานตามระบบ ERP-HR (รหัส 12 หลัก) และการจับคู่กับ org_units (รหัส 2 หลัก)
-- สองชุดรหัสนี้เป็นคนละระบบ ห้ามเทียบกันตรง ๆ ต้องผูกผ่านตารางนี้ (CLAUDE.md หัวข้อ 18)
-- แถวถูกสร้าง/อัปเดตอัตโนมัติเมื่อบุคลากร login แล้ว ERP ส่งหน่วยงานที่ยังไม่เคยเห็นมา
CREATE TABLE erp_org_units (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  erp_code     text NOT NULL UNIQUE CHECK (erp_code ~ '^[0-9]{12}$'),
  name_th      text NOT NULL,
  -- ระดับใน ERP: faculty = คณะ/สำนัก (facultyid), department = กอง/ฝ่าย (departmentid)
  level        text NOT NULL CHECK (level IN ('faculty', 'department')),
  -- หน่วยงานในระบบที่จับคู่แล้ว (NULL = ยังไม่ได้จับคู่)
  org_unit_id  uuid REFERENCES org_units (id),
  -- auto = ระบบจับคู่จากชื่อที่ตรงกัน (คำนวณใหม่ได้), manual = ผู้ดูแลกำหนดเอง (ห้ามถูกทับ)
  match_type   text CHECK (match_type IN ('auto', 'manual')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- จับคู่แล้วต้องระบุวิธีจับคู่เสมอ และยังไม่จับคู่ต้องไม่มีวิธีจับคู่
  CONSTRAINT erp_org_units_match_pair_chk CHECK ((org_unit_id IS NULL) = (match_type IS NULL))
);

CREATE INDEX erp_org_units_org_unit_id_idx ON erp_org_units (org_unit_id);

CREATE TRIGGER trg_erp_org_units_set_updated_at
  BEFORE UPDATE ON erp_org_units
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS erp_org_units;
