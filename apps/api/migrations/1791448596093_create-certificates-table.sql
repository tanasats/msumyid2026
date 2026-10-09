-- Up Migration

-- ใบรับรอง S/MIME ที่ Intermediate CA ออกให้ผู้ใช้ (docs/design/certificates.md)
-- ทั้งใบที่ระบบออกเอง (issued) และใบเดิมที่นำเข้าจาก index.txt ของ openssl ca (imported)
-- ไม่มี soft delete โดยตั้งใจ: ใบรับรองที่ CA เซ็นแล้วลบไม่ได้ ต้องคงอยู่เพื่อเพิกถอนและออก CRL
CREATE TABLE certificates (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  -- เจ้าของใบ — NULL ได้เฉพาะใบที่นำเข้าแล้วยังไม่พบผู้ใช้ (ผูกเมื่อผู้ใช้ login ครั้งแรก)
  user_id             uuid REFERENCES users (id),
  -- serial เป็นเลขฐาน 16 ตัวพิมพ์เล็ก ไม่มีเลข 0 นำหน้า (ทำให้เทียบกับ index.txt ที่เป็นตัวพิมพ์ใหญ่ได้หลังแปลง)
  serial_number       text NOT NULL UNIQUE CHECK (serial_number ~ '^(0|[1-9a-f][0-9a-f]*)$'),
  -- ค่าใน subject ตอนออกใบ (ชื่อ/อีเมลของผู้ใช้อาจเปลี่ยนภายหลัง แต่ใบรับรองไม่เปลี่ยน)
  subject_cn          text NOT NULL,
  email               text NOT NULL,
  not_before          timestamptz NOT NULL,
  not_after           timestamptz NOT NULL,
  -- เพิกถอนแล้ว = revoked_at ไม่เป็น NULL (เหตุผลใช้ชื่อตาม openssl ca -crl_reason)
  revoked_at          timestamptz,
  revocation_reason   text CHECK (revocation_reason IN (
                        'unspecified', 'keyCompromise', 'CACompromise',
                        'affiliationChanged', 'superseded', 'cessationOfOperation'
                      )),
  -- ผู้เพิกถอน (NULL = ระบบทำเอง หรือนำเข้าจากระบบเดิม)
  revoked_by          uuid REFERENCES users (id),
  source              text NOT NULL CHECK (source IN ('issued', 'imported')),
  certificate_pem     text NOT NULL,
  -- SHA-256 ของใบรับรอง (DER) ฐาน 16 ตัวพิมพ์เล็ก ไม่มี : คั่น
  fingerprint_sha256  text NOT NULL UNIQUE CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT certificates_validity_chk CHECK (not_after > not_before),
  -- เวลาและเหตุผลการเพิกถอนต้องมาคู่กันเสมอ
  CONSTRAINT certificates_revoked_pair_chk CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
);

-- หน้า "ใบรับรองของฉัน" (ล่าสุดก่อน) และการนับใบที่ใช้งานอยู่ของผู้ใช้
CREATE INDEX certificates_user_id_idx ON certificates (user_id, created_at DESC);
-- ผูกใบที่นำเข้ากับผู้ใช้ด้วยอีเมลตอน login — partial index เก็บเฉพาะใบที่ยังไม่มีเจ้าของ
CREATE INDEX certificates_unowned_email_idx ON certificates (lower(email)) WHERE user_id IS NULL;

CREATE TRIGGER trg_certificates_set_updated_at
  BEFORE UPDATE ON certificates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS certificates;
