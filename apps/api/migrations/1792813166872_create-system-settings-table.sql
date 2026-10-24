-- Up Migration

-- ค่าตั้งของระบบที่ super_admin แก้ได้จากหน้า /admin/settings (ตัดสินใจ 2026-10-24) — ตารางนี้มีได้แถวเดียว (id = true)
-- ย้ายมาจาก env: ALLOWED_EMAIL_DOMAINS, SESSION_TTL_DAYS, CRL_VALIDITY_DAYS, CRL_REISSUE_HOURS
-- ค่าเริ่มต้น = ค่าเดิมใน .env.example และ deploy/env/api.env.example (ถ้า production ตั้งค่าอื่นไว้ ต้องแก้ในหน้าตั้งค่าหลัง deploy)
CREATE TABLE system_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- โดเมนอีเมลที่ไม่ต้องรออนุมัติ (ตัวพิมพ์เล็ก) — โดเมนอื่น = บุคลากรภายนอก รออนุมัติ
  allowed_email_domains  text[] NOT NULL DEFAULT ARRAY['msu.ac.th']
                         CHECK (cardinality(allowed_email_domains) BETWEEN 1 AND 20),
  -- อายุ session ที่สร้างใหม่ (session เดิมคงวันหมดอายุเดิม)
  session_ttl_days       integer NOT NULL DEFAULT 7 CHECK (session_ttl_days BETWEEN 1 AND 30),
  -- CRL: อายุแต่ละฉบับ (next_update) และออกฉบับใหม่ทุกกี่ชั่วโมงแม้ไม่มีการเพิกถอน
  crl_validity_days      integer NOT NULL DEFAULT 7 CHECK (crl_validity_days BETWEEN 1 AND 30),
  crl_reissue_hours      integer NOT NULL DEFAULT 24 CHECK (crl_reissue_hours BETWEEN 1 AND 168),
  updated_by             uuid REFERENCES users (id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- ต้องออกฉบับใหม่ก่อนฉบับเดิมหมดอายุ ไม่เช่นนั้นจะมีช่วงที่ CRL หมดอายุ (ผู้ตรวจลายเซ็นถือว่าตรวจการเพิกถอนไม่ได้)
  CONSTRAINT system_settings_crl_reissue_chk CHECK (crl_reissue_hours < crl_validity_days * 24)
);

CREATE TRIGGER trg_system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO system_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ประวัติการแก้ (append-only) เก็บค่าก่อน/หลังทั้งชุด แบบเดียวกับ certificate_policy_logs
CREATE TABLE system_setting_logs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  actor_id    uuid NOT NULL REFERENCES users (id),
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX system_setting_logs_created_at_idx ON system_setting_logs (created_at DESC);

CREATE TRIGGER trg_system_setting_logs_append_only
  BEFORE UPDATE OR DELETE ON system_setting_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE TRIGGER trg_system_setting_logs_no_truncate
  BEFORE TRUNCATE ON system_setting_logs
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- Down Migration

DROP TABLE IF EXISTS system_setting_logs;
DROP TABLE IF EXISTS system_settings;
