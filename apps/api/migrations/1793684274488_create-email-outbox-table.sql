-- Up Migration

-- คิวอีเมลแจ้งเตือน (ตัดสินใจ 2026-11-03 — docs/design/email.md)
-- งานในระบบเขียนคิวใน transaction เดียวกับงานนั้น (งานล้ม = ไม่มีอีเมล) แล้ว job ใน API ส่งจากคิว (Gmail ล่ม = ลองใหม่ ไม่ทำให้งานล้ม)
-- เก็บเฉพาะผู้รับ (user_id) + ชื่อแม่แบบ + ค่าที่ใส่ในแม่แบบ — อีเมลและชื่อผู้รับอ่านจาก users ตอนส่ง ไม่คัดลอกเก็บซ้ำ
-- ลบแถวที่เก่ากว่า 30 วันตามรอบ (PDPA — ระยะเก็บที่ประกาศไว้)
CREATE TABLE email_outbox (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  recipient_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- ชื่อแม่แบบใน src/mail/templates.ts
  template           text NOT NULL CHECK (template ~ '^[a-z_]+$'),
  params             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- pending = รอส่ง/รอลองใหม่, sent = ส่งแล้ว, failed = ลองครบแล้วไม่สำเร็จ, cancelled = ไม่ส่ง (ผู้รับถูกลบบัญชี)
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL DEFAULT now(),
  -- ข้อความ error ของตัวส่ง (ไม่มีเนื้อหาอีเมล)
  last_error         text CHECK (char_length(last_error) <= 1000),
  sent_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_sent_chk CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);

-- job ดึงเฉพาะอีเมลที่ถึงเวลาส่ง — partial index เล็กกว่าทั้งตาราง
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
-- ลบตามระยะเก็บ
CREATE INDEX email_outbox_created_at_idx ON email_outbox (created_at);
-- FK ON DELETE CASCADE จากผู้ใช้
CREATE INDEX email_outbox_recipient_idx ON email_outbox (recipient_user_id);

CREATE TRIGGER trg_email_outbox_set_updated_at
  BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS email_outbox;
