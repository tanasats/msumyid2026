-- Up Migration

-- เวลาที่ session นี้ยืนยัน MFA ล่าสุด (docs/design/mfa.md)
-- NULL = ยังไม่ยืนยัน: ผู้ใช้ที่เปิด MFA ใช้ระบบไม่ได้จนกว่าจะใส่รหัส (requireAuth ตอบ MFA_REQUIRED)
-- ใช้ตรวจการยืนยันซ้ำก่อนทำรายการสำคัญด้วย (ต้องยืนยันภายใน 10 นาที)
-- session เดิมทั้งหมดเป็น NULL — ยังไม่มีใครเปิด MFA ตอนเพิ่มคอลัมน์ จึงไม่กระทบ
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;

-- Down Migration

ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_verified_at;
