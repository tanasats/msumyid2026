-- Up Migration

-- ค้นหาผู้ใช้ด้วยข้อความบางส่วน (ILIKE '%สมชาย%') ใช้ index ปกติ (btree) ไม่ได้เพราะมี % นำหน้า
-- pg_trgm แตกข้อความเป็นชุดละ 3 ตัวอักษร (trigram) แล้วทำ GIN index ให้ LIKE/ILIKE แบบนี้ใช้ index ได้
-- pg_trgm เป็น trusted extension (PostgreSQL 13+) เจ้าของฐานข้อมูลสร้างได้โดยไม่ต้องเป็น superuser
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- partial index: เก็บเฉพาะผู้ใช้ที่ยังไม่ถูกลบ ตรงกับเงื่อนไขของหน้าค้นหา
CREATE INDEX users_display_name_trgm_idx ON users USING gin (display_name gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX users_email_trgm_idx ON users USING gin (lower(email) gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS users_email_trgm_idx;
DROP INDEX IF EXISTS users_display_name_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
