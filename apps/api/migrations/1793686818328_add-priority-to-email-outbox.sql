-- Up Migration

-- อีเมลระยะที่ 2 (docs/design/email.md): เตือนใบใกล้หมดอายุอาจมาเป็นชุดใหญ่ (ใบที่นำเข้าหมดอายุพร้อมกัน)
-- priority 0 = ปกติ (ผลการพิจารณา/แจ้งเพื่อความปลอดภัย) ส่งก่อน, 1 = ต่ำ (เตือนใบใกล้หมดอายุ) — ชุดใหญ่จึงไม่ดันอีเมลสำคัญออกไป
ALTER TABLE email_outbox
  ADD COLUMN priority smallint NOT NULL DEFAULT 0 CHECK (priority IN (0, 1));

-- job ดึงตาม priority แล้วเวลา — แทน index เดิมที่มีแค่ next_attempt_at
DROP INDEX IF EXISTS email_outbox_due_idx;
CREATE INDEX email_outbox_due_idx ON email_outbox (priority, next_attempt_at) WHERE status = 'pending';
-- นับอีเมลที่ส่งใน 24 ชั่วโมงล่าสุด (เพดานต่อวันกันชนโควตา Gmail)
CREATE INDEX email_outbox_sent_at_idx ON email_outbox (sent_at) WHERE status = 'sent';

-- Down Migration

DROP INDEX IF EXISTS email_outbox_sent_at_idx;
DROP INDEX IF EXISTS email_outbox_due_idx;
ALTER TABLE email_outbox DROP COLUMN IF EXISTS priority;
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
