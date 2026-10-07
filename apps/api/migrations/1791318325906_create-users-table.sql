-- Up Migration

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  -- ตัวระบุบัญชี Google (ไม่ใช้ email เพราะเปลี่ยนได้) — NULL ได้สำหรับบัญชีรหัสผ่าน (ขั้น 2.7)
  google_sub       text UNIQUE,
  email            text NOT NULL,
  name             text NOT NULL,
  picture_url      text,
  -- ประเภทบัญชี ระบบกำหนดจาก email ตอน login: นิสิต / บุคลากร มมส. / บุคลากรภายนอก
  account_type     text NOT NULL CHECK (account_type IN ('student', 'staff', 'external')),
  -- คณะของนิสิต (หลักที่ 5-6 ของรหัส) หรือหน่วยงานของบุคลากร — NULL ถ้าไม่พบ
  org_unit_id      uuid REFERENCES org_units (id),
  -- บัญชีภายนอกต้องรออนุมัติก่อนใช้งาน ส่วนนิสิต/บุคลากรได้ 'approved' ทันที
  approval_status  text NOT NULL DEFAULT 'approved'
                   CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  -- ผู้อนุมัติ/ปฏิเสธ (NULL = ระบบอนุมัติอัตโนมัติ หรือยังรออยู่)
  approved_by      uuid REFERENCES users (id),
  approved_at      timestamptz,
  -- false = ระงับการใช้งาน (ต้องเข้าระบบไม่ได้ทันที)
  is_active        boolean NOT NULL DEFAULT true,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  -- ผู้อนุมัติกับเวลาต้องมาคู่กันเสมอ
  CONSTRAINT users_approved_pair_chk CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

-- ค้นหาผู้ใช้ด้วย email แบบไม่สนตัวพิมพ์ (seed super_admin, หน้าค้นหาผู้ใช้)
CREATE INDEX users_email_lower_idx ON users (lower(email)) WHERE deleted_at IS NULL;
-- หน้ารายการบัญชีรออนุมัติ — partial index เก็บเฉพาะแถว pending จึงเล็กมาก
CREATE INDEX users_pending_idx ON users (created_at)
  WHERE approval_status = 'pending' AND deleted_at IS NULL;
CREATE INDEX users_org_unit_id_idx ON users (org_unit_id);

CREATE TRIGGER trg_users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS users;
