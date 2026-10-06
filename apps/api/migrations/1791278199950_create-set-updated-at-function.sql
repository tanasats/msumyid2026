-- Up Migration

-- ฟังก์ชัน trigger กลาง: ตั้ง updated_at = เวลาปัจจุบันทุกครั้งที่ UPDATE แถว
-- ทุกตารางที่มี updated_at ต้องผูก trigger นี้ เช่น
--   CREATE TRIGGER trg_users_set_updated_at BEFORE UPDATE ON users
--   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Down Migration

DROP FUNCTION IF EXISTS set_updated_at();
