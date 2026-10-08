-- Up Migration

-- ข้อมูลบุคลากรจาก ERP-HR (1 แถวต่อผู้ใช้) อัปเดตทุกครั้งที่บุคลากร login และเรียก ERP สำเร็จ
-- เก็บเท่าที่จำเป็น (PDPA): ไม่เก็บเบอร์โทรศัพท์และอีเมลสำรองจาก ERP
CREATE TABLE staff_profiles (
  id                          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                     uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  -- รหัสบุคลากรของ ERP — ไม่ UNIQUE เพราะบุคลากร 1 คนอาจมีบัญชี Google ของมหาวิทยาลัยมากกว่า 1 บัญชี
  -- ถ้าบังคับ UNIQUE บัญชีที่ 2 จะ login ไม่ได้
  staff_id                    text NOT NULL,
  prefix_th                   text,
  first_name_th               text NOT NULL,
  last_name_th                text NOT NULL,
  prefix_en                   text,
  first_name_en               text,
  last_name_en                text,
  position_th                 text,
  -- คณะ/สำนัก และกอง/ฝ่ายตาม ERP (ชื่อและการจับคู่กับ org_units อยู่ที่ erp_org_units)
  faculty_erp_org_unit_id     uuid REFERENCES erp_org_units (id),
  department_erp_org_unit_id  uuid REFERENCES erp_org_units (id),
  -- กลุ่มงาน/สาขา (ระดับย่อยกว่ากอง ไม่จับคู่กับ org_units จึงเก็บรหัสและชื่อไว้ตรงนี้)
  program_erp_code            text,
  program_name_th             text,
  -- เวลาที่ดึงข้อมูลจาก ERP สำเร็จล่าสุด
  synced_at                   timestamptz NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- ค้นหาบุคลากรด้วยรหัส ERP
CREATE INDEX staff_profiles_staff_id_idx ON staff_profiles (staff_id);
CREATE INDEX staff_profiles_faculty_idx ON staff_profiles (faculty_erp_org_unit_id);
CREATE INDEX staff_profiles_department_idx ON staff_profiles (department_erp_org_unit_id);

CREATE TRIGGER trg_staff_profiles_set_updated_at
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS staff_profiles;
