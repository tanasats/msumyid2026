-- Up Migration

-- session แบบ opaque token: เก็บเฉพาะ SHA-256 ของ token (32 ไบต์) ห้ามเก็บ token ดิบ
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- เพิกถอน session ทั้งหมดของผู้ใช้ (เช่น ถูกระงับ) / ลบ session หมดอายุ
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TRIGGER trg_sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS sessions;
