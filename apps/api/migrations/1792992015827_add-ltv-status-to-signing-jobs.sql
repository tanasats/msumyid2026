-- Up Migration

-- LTV ของไฟล์ที่ลงนามแล้ว (docs/design/document-signing.md ระยะ D4b) — แสดงในผลการลงนาม
-- embedded = ฝังใบรับรอง + CRL (DSS) แล้ว
-- skipped_locked = เอกสารที่ล็อก (DocMDP P=1) ไม่ใส่ เพราะ Acrobat ถือว่า DSS ที่ต่อท้ายเป็นการแก้ไข (ยืนยัน 2026-10-26)
-- unavailable = ได้ใบรับรอง/CRL ไม่ครบ (เช่น ดึง CRL ของ TUC ไม่ได้) ลงนามต่อแบบไม่มี LTV
-- NULL = ยังไม่ได้ลงนาม หรือลงนามก่อนระยะ D4b
ALTER TABLE signing_jobs
  ADD COLUMN ltv_status text CHECK (ltv_status IN ('embedded', 'skipped_locked', 'unavailable'));

-- Down Migration

ALTER TABLE signing_jobs DROP COLUMN IF EXISTS ltv_status;
