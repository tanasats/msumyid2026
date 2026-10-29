-- Up Migration

-- โควตาขอใบรับรองประจำตัวใหม่หลังเพิกถอน (ตัดสินใจ 2026-10-29 — docs/design/certificates.md หัวข้อ "การควบคุมการเพิกถอน")
-- นับใบประจำตัวที่ผู้ใช้เป็นผู้เริ่มเพิกถอนในรอบ 365 วัน — เกินค่านี้ต้องส่งคำขอใบประจำตัว (รออนุมัติ) แม้มี certificate:request
-- 0 = เพิกถอนแล้วทุกครั้งต้องส่งคำขอ — เพิ่มคอลัมน์พร้อม DEFAULT จึงไม่กระทบแถวเดิม
ALTER TABLE system_settings
  ADD COLUMN primary_reissue_limit integer NOT NULL DEFAULT 2 CHECK (primary_reissue_limit BETWEEN 0 AND 20);

-- Down Migration

ALTER TABLE system_settings DROP COLUMN IF EXISTS primary_reissue_limit;
