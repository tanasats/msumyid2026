-- Up Migration

-- ประวัติ MFA ในประวัติบัญชี (docs/design/mfa.md): เปิด / ปิด / ผู้ดูแลรีเซ็ต / ใช้รหัสกู้คืน / ออกรหัสกู้คืนชุดใหม่
-- changes ไม่เก็บ secret หรือรหัส
ALTER TABLE user_audit_logs DROP CONSTRAINT user_audit_logs_action_check;
ALTER TABLE user_audit_logs ADD CONSTRAINT user_audit_logs_action_check CHECK (action IN (
  'create', 'update', 'deactivate', 'activate', 'delete',
  'approve', 'reject', 'link_google', 'expire',
  'mfa_enable', 'mfa_disable', 'mfa_reset', 'mfa_recovery_used', 'mfa_recovery_regenerate'
));

-- Down Migration

-- ถ้ามี log ของ MFA อยู่แล้ว migration จะล้ม (ตั้งใจ — log ลบไม่ได้)
ALTER TABLE user_audit_logs DROP CONSTRAINT user_audit_logs_action_check;
ALTER TABLE user_audit_logs ADD CONSTRAINT user_audit_logs_action_check CHECK (action IN (
  'create', 'update', 'deactivate', 'activate', 'delete',
  'approve', 'reject', 'link_google', 'expire'
));
