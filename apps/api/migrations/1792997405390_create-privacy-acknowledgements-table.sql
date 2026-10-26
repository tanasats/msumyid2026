-- Up Migration

-- การรับทราบประกาศความเป็นส่วนตัว (docs/design/pdpa.md) — 1 แถวต่อผู้ใช้ต่อเวอร์ชันของประกาศ
-- เวอร์ชันปัจจุบันอยู่ในโค้ด (privacy-service.ts) เปลี่ยนประกาศ = เพิ่มเวอร์ชัน ผู้ใช้ทุกคนต้องรับทราบใหม่ ส่วนแถวเดิมคงไว้เป็นหลักฐาน
-- ไม่มีข้อมูลส่วนบุคคลในแถว (มีแค่ user_id + เวลา) จึงไม่ต้องลบตอนลบบัญชี (anonymize)
CREATE TABLE privacy_acknowledgements (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id          uuid NOT NULL REFERENCES users (id),
  notice_version   integer NOT NULL CHECK (notice_version > 0),
  acknowledged_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- กดซ้ำได้ไม่เกิดแถวใหม่ และเป็น index ของการตรวจทุก request (WHERE user_id = ? AND notice_version = ?)
  CONSTRAINT privacy_acknowledgements_user_version_key UNIQUE (user_id, notice_version)
);

CREATE TRIGGER trg_privacy_acknowledgements_set_updated_at
  BEFORE UPDATE ON privacy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS privacy_acknowledgements;
