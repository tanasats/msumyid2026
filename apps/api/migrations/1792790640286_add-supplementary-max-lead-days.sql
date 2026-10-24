-- Up Migration

-- ใบเสริม: วันเริ่มของคำขอล่วงหน้าได้ไม่เกินกี่วันนับจากวันนี้ (ยืนยันกับผู้ใช้ 2026-10-24 ค่าเริ่มต้น 90)
-- ADD COLUMN พร้อม DEFAULT ค่าคงที่: PostgreSQL ไม่ต้องเขียนตารางใหม่ (ตารางนี้มีแถวเดียวอยู่แล้ว)
ALTER TABLE certificate_policies
  ADD COLUMN supplementary_max_lead_days integer NOT NULL DEFAULT 90
    CHECK (supplementary_max_lead_days BETWEEN 0 AND 365);

-- Down Migration

ALTER TABLE certificate_policies DROP COLUMN IF EXISTS supplementary_max_lead_days;
