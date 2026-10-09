-- Up Migration

-- key สำรอง (escrow) ของใบรับรอง — ต้องมีเพราะใบ S/MIME ใช้เข้ารหัสอีเมล key หาย = เปิดอีเมลเก่าไม่ได้
-- เก็บเฉพาะ ciphertext: private key เข้ารหัสด้วย data key (AES-256-GCM) และ data key ถูกห่อด้วย KEK
-- KEK อยู่ที่บริการเซ็น (apps/signer) เท่านั้น API และฐานข้อมูลถอดรหัสเองไม่ได้
-- แยกจากตาราง certificates เพื่อให้ query รายการใบรับรองไม่แตะข้อมูลก้อนนี้
CREATE TABLE certificate_key_escrows (
  certificate_id    uuid PRIMARY KEY REFERENCES certificates (id),
  -- iv (12 ไบต์) + auth tag (16 ไบต์) + ciphertext ของ private key (PKCS#8 DER)
  encrypted_key     bytea NOT NULL,
  -- iv + auth tag + ciphertext ของ data key ที่ห่อด้วย KEK
  wrapped_data_key  bytea NOT NULL,
  -- KEK ตัวที่ใช้ห่อ (รองรับการเปลี่ยน KEK โดยไม่ต้องห่อใหม่ทั้งหมดทันที)
  kek_id            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_certificate_key_escrows_set_updated_at
  BEFORE UPDATE ON certificate_key_escrows
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS certificate_key_escrows;
