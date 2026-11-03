-- Up Migration

-- งานแจ้งเตือนตามวัน (docs/design/email.md ระยะที่ 2) — บันทึกว่าวันนี้ทำแล้ว กันส่งซ้ำเมื่อ job รันหลายรอบ/API หลายตัว
-- kind: approver_digest = สรุปงานรอดำเนินการให้ผู้อนุมัติ (08:00 วันจันทร์–ศุกร์ เวลาไทย)
CREATE TABLE notification_runs (
  kind        text NOT NULL CHECK (kind ~ '^[a-z_]+$'),
  -- วันที่ตามเวลาไทย
  run_on      date NOT NULL,
  -- จำนวนอีเมลที่เข้าคิว (0 = ไม่มีงานค้าง)
  queued      integer NOT NULL DEFAULT 0 CHECK (queued >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, run_on)
);

-- Down Migration

DROP TABLE IF EXISTS notification_runs;
