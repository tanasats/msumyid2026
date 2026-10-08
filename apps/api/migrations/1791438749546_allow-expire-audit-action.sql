-- Up Migration

-- เพิ่ม action 'expire' = ระบบปิดบัญชีอัตโนมัติเมื่อถึงวันหมดอายุ (actor_id = NULL)
-- แก้ CHECK constraint ต้องลบแล้วสร้างใหม่ — log เดิมมีแต่ action เดิมจึงผ่านเงื่อนไขใหม่ทุกแถว
ALTER TABLE user_audit_logs DROP CONSTRAINT user_audit_logs_action_check;
ALTER TABLE user_audit_logs ADD CONSTRAINT user_audit_logs_action_check CHECK (action IN (
  'create', 'update', 'deactivate', 'activate', 'delete',
  'approve', 'reject', 'link_google', 'expire'
));

-- Down Migration

-- ถ้ามี log 'expire' อยู่แล้ว migration จะล้ม (ตั้งใจ — log ลบไม่ได้)
ALTER TABLE user_audit_logs DROP CONSTRAINT user_audit_logs_action_check;
ALTER TABLE user_audit_logs ADD CONSTRAINT user_audit_logs_action_check CHECK (action IN (
  'create', 'update', 'deactivate', 'activate', 'delete',
  'approve', 'reject', 'link_google'
));
