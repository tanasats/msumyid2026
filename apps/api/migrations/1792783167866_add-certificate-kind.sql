-- Up Migration

-- ประเภทของใบรับรอง (ตัดสินใจ 2026-10-24, docs/design/certificates.md)
-- primary = ใบหลัก ผู้ใช้ขอเองได้ 1 ใบที่ใช้งานอยู่ (ขอใหม่ได้ในช่วงต่ออายุ)
-- supplementary = ใบเสริม เฉพาะกิจ/ระยะสั้น ออกเมื่อผู้มี certificate:approve อนุมัติคำขอ
-- ใบเดิมทั้งหมด (รวมที่นำเข้าจากระบบเดิม) เป็นใบหลักตามค่า DEFAULT
ALTER TABLE certificates
  ADD COLUMN kind text NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary', 'supplementary'));

-- นับ/ค้นใบที่ใช้งานอยู่ของผู้ใช้ตามประเภท (ตรวจตอนขอใบใหม่)
CREATE INDEX certificates_user_id_kind_idx ON certificates (user_id, kind, not_after DESC)
  WHERE revoked_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS certificates_user_id_kind_idx;
ALTER TABLE certificates DROP COLUMN IF EXISTS kind;
