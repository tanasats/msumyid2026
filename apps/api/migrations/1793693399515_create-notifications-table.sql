-- Up Migration

-- การแจ้งเตือนในระบบ (ตัดสินใจ 2026-11-03 — docs/design/notifications.md)
-- เขียนใน transaction เดียวกับงานที่แจ้ง (notify) เก็บแม่แบบ + params ข้อความไทยสร้างตอนแสดง (แม่แบบชุดเดียวกับอีเมล)
-- ลบเมื่อเกิน 90 วัน (job) และลบทันทีเมื่อลบบัญชี (PDPA)
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  template    text NOT NULL CHECK (template ~ '^[a-z_]+$'),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = ยังไม่อ่าน
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- รายการของฉัน ใหม่ก่อน (id เป็น uuidv7 เรียงตามเวลา จึงใช้แบ่งหน้าแบบ cursor ได้)
CREATE INDEX notifications_user_id_idx ON notifications (user_id, id DESC);
-- นับที่ยังไม่อ่าน (กระดิ่ง — เรียกทุกหน้า) — partial index เล็กกว่าทั้งตาราง
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
-- ลบตามระยะเก็บ
CREATE INDEX notifications_created_at_idx ON notifications (created_at);

CREATE TRIGGER trg_notifications_set_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS notifications;
