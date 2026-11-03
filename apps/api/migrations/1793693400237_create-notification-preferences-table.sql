-- Up Migration

-- การตั้งค่าการแจ้งเตือนต่อหมวด (docs/design/notifications.md) — ไม่มีแถว = ค่าเริ่มต้น (เปิดทั้งในระบบและอีเมล)
-- หมวดที่ปิดไม่ได้ (ความปลอดภัย, ผลการอนุมัติบัญชี) ไม่มีในตารางนี้
CREATE TABLE notification_preferences (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('decisions', 'expiry', 'approver_digest')),
  in_app      boolean NOT NULL DEFAULT true,
  email       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_preferences_user_category_key UNIQUE (user_id, category)
);

CREATE TRIGGER trg_notification_preferences_set_updated_at
  BEFORE UPDATE ON notification_preferences
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS notification_preferences;
