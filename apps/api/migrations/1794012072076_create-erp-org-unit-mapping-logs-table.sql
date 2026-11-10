-- Up Migration

-- ประวัติการจับคู่หน่วยงาน ERP ที่ผู้ดูแลเปลี่ยน (หน้า /admin/org-units) — append-only เขียนใน transaction เดียวกับการเปลี่ยน
-- set_manual = ผู้ดูแลกำหนดหน่วยงานเอง, reset_auto = คืนให้ระบบจับคู่จากชื่อ (ผลอาจเป็น auto หรือยังไม่จับคู่)
-- from_* / to_* = การจับคู่ก่อนและหลัง (NULL = ยังไม่จับคู่), affected_users = จำนวนบุคลากรที่หน่วยงานเปลี่ยนจากครั้งนี้
CREATE TABLE erp_org_unit_mapping_logs (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  erp_org_unit_id   uuid NOT NULL REFERENCES erp_org_units (id),
  actor_id          uuid NOT NULL REFERENCES users (id),
  action            text NOT NULL CHECK (action IN ('set_manual', 'reset_auto')),
  from_org_unit_id  uuid REFERENCES org_units (id),
  from_match_type   text CHECK (from_match_type IN ('auto', 'manual')),
  to_org_unit_id    uuid REFERENCES org_units (id),
  to_match_type     text CHECK (to_match_type IN ('auto', 'manual')),
  reason            text NOT NULL,
  affected_users    integer NOT NULL CHECK (affected_users >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- คู่ (หน่วยงาน, วิธีจับคู่) ต้องมาด้วยกันเหมือน CHECK ของ erp_org_units
  CONSTRAINT erp_org_unit_mapping_logs_from_pair_chk CHECK ((from_org_unit_id IS NULL) = (from_match_type IS NULL)),
  CONSTRAINT erp_org_unit_mapping_logs_to_pair_chk CHECK ((to_org_unit_id IS NULL) = (to_match_type IS NULL))
);

-- ประวัติของหน่วยงาน ERP หนึ่ง (ล่าสุดก่อน)
CREATE INDEX erp_org_unit_mapping_logs_unit_idx ON erp_org_unit_mapping_logs (erp_org_unit_id, created_at DESC);
CREATE INDEX erp_org_unit_mapping_logs_actor_id_idx ON erp_org_unit_mapping_logs (actor_id);

-- ใช้ฟังก์ชันกลาง prevent_append_only_mutation() (สร้างใน migration ของ user_audit_logs)
CREATE TRIGGER trg_erp_org_unit_mapping_logs_append_only
  BEFORE UPDATE OR DELETE ON erp_org_unit_mapping_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_erp_org_unit_mapping_logs_no_truncate
  BEFORE TRUNCATE ON erp_org_unit_mapping_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS erp_org_unit_mapping_logs;
