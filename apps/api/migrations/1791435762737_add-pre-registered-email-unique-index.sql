-- Up Migration

-- บัญชีที่ผู้ดูแลลงทะเบียนล่วงหน้า (google_sub = NULL) ต้องมีอีเมลไม่ซ้ำกัน
-- ตอน login ครั้งแรกระบบหาแถวนี้ด้วยอีเมลเพื่อผูก google_sub — ถ้าซ้ำจะไม่รู้ว่าผูกกับแถวไหน
-- partial unique index: บังคับเฉพาะแถวที่ยังไม่ผูก Google และไม่ถูกลบ (บัญชี Google ปกติอีเมลซ้ำได้ เพราะตัวระบุจริงคือ google_sub)
-- ถ้าใน dev มีแถวซ้ำอยู่แล้ว (ไม่ควรมี) migration จะล้ม ให้ตรวจข้อมูลก่อน
CREATE UNIQUE INDEX users_pre_registered_email_idx ON users (lower(email))
  WHERE google_sub IS NULL AND deleted_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS users_pre_registered_email_idx;
