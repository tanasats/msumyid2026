-- Up Migration

-- คำขอใบรับรองเสริม (ลงนามเอกสารเท่านั้น, docs/design/certificates.md หัวข้อ "ใบรับรองเสริม")
-- ผู้ใช้ส่งคำขอ → ผู้มี certificate:approve อนุมัติ (แก้ช่วงได้) → ผู้ใช้กด "รับใบรับรอง" ตั้งรหัส .p12 เอง ระบบจึงออกใบ
-- ช่วงวันที่เป็น date ตามเวลาประเทศไทย: ใบเริ่ม 00:00 ของวันแรก สิ้นสุด 23:59:59 ของวันสุดท้าย (service แปลงเป็นเวลา)
-- "หมดเวลา" (อนุมัติแล้วไม่มารับจนเลยวันสิ้นสุด) คำนวณใน query ไม่เก็บเป็นสถานะ จึงไม่ต้องมี job
CREATE TABLE supplementary_certificate_requests (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES users (id),
  -- วัตถุประสงค์ (service บังคับไม่ว่าง) — ลบข้อมูลส่วนบุคคล (PDPA) ล้างเป็น '' แบบเดียวกับ certificates
  purpose         text NOT NULL CHECK (char_length(purpose) <= 1000),
  requested_start date NOT NULL,
  requested_end   date NOT NULL,
  -- ช่วงที่อนุมัติจริง (ผู้อนุมัติแก้ได้ภายในเพดาน) มีค่าเมื่ออนุมัติแล้ว
  approved_start  date,
  approved_end    date,
  -- pending = รออนุมัติ, approved = อนุมัติแล้ว รอผู้ขอรับใบ, issued = ออกใบแล้ว,
  -- rejected = ปฏิเสธ, cancelled = ผู้ขอยกเลิก หรือระบบยกเลิกเมื่อปิดบัญชี
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'issued', 'rejected', 'cancelled')),
  decided_by      uuid REFERENCES users (id),
  decided_at      timestamptz,
  -- บันทึกของผู้อนุมัติ (บังคับเมื่อปฏิเสธ) — PDPA ล้างเป็น NULL
  decision_note   text CHECK (char_length(decision_note) <= 1000),
  -- ใบที่ออกจากคำขอนี้ (1 คำขอ = 1 ใบ)
  certificate_id  uuid UNIQUE REFERENCES certificates (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplementary_requests_requested_range_chk CHECK (requested_end >= requested_start),
  CONSTRAINT supplementary_requests_approved_range_chk CHECK (
    (approved_start IS NULL) = (approved_end IS NULL) AND (approved_end IS NULL OR approved_end >= approved_start)
  ),
  -- อนุมัติแล้ว/ออกใบแล้ว ต้องมีช่วงที่อนุมัติ
  CONSTRAINT supplementary_requests_approved_chk CHECK (
    status NOT IN ('approved', 'issued') OR approved_start IS NOT NULL
  ),
  -- ผู้ตัดสินกับเวลาต้องมาคู่กัน และสถานะที่ผ่านการตัดสินแล้วต้องมี
  CONSTRAINT supplementary_requests_decided_pair_chk CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT supplementary_requests_decided_chk CHECK (
    status NOT IN ('approved', 'issued', 'rejected') OR decided_at IS NOT NULL
  ),
  -- ออกใบแล้ว ⇔ มีใบรับรอง
  CONSTRAINT supplementary_requests_issued_chk CHECK ((status = 'issued') = (certificate_id IS NOT NULL))
);

-- คิวของผู้อนุมัติ (เฉพาะที่รออนุมัติ เก่าก่อน) — partial index เล็กกว่าทั้งตารางมาก เพราะคำขอส่วนใหญ่ปิดไปแล้ว
CREATE INDEX supplementary_requests_pending_idx ON supplementary_certificate_requests (created_at)
  WHERE status = 'pending';
-- หน้า "คำขอของฉัน" (ล่าสุดก่อน) และการนับคำขอที่ค้างอยู่ของผู้ใช้
CREATE INDEX supplementary_requests_user_id_idx ON supplementary_certificate_requests (user_id, created_at DESC);

CREATE TRIGGER trg_supplementary_certificate_requests_set_updated_at
  BEFORE UPDATE ON supplementary_certificate_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS supplementary_certificate_requests;
