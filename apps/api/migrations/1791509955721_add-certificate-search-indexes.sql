-- Up Migration

-- หน้าค้นหาใบรับรองของผู้ดูแล: ชื่อในใบ (subject_cn) และอีเมลแบบบางส่วน (ILIKE '%...%')
-- ใช้ trigram (GIN) เหมือนการค้นหาผู้ใช้ — pg_trgm เปิดไว้แล้วใน migration enable-pg-trgm-for-user-search
-- ค้นหาด้วย serial ใช้ unique index เดิมของ serial_number (เทียบตรงตัว)
CREATE INDEX certificates_subject_cn_trgm_idx ON certificates USING gin (subject_cn gin_trgm_ops);
CREATE INDEX certificates_email_trgm_idx ON certificates USING gin (lower(email) gin_trgm_ops);

-- Down Migration

DROP INDEX IF EXISTS certificates_email_trgm_idx;
DROP INDEX IF EXISTS certificates_subject_cn_trgm_idx;
