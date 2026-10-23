-- Up Migration

-- เปลี่ยนชื่อเรียกใบของผู้ใช้จาก "ใบรับรองหลัก" เป็น "ใบรับรองประจำตัว" (ตัดสินใจ 2026-10-24)
-- เพราะ "ใบรับรองหลัก" ใช้หมายถึง root CA ในหน้า /root-ca อยู่แล้ว — แก้เฉพาะข้อความ ไม่เปลี่ยน code
UPDATE permissions
SET description_th = 'กำหนดนโยบายอายุใบรับรองประจำตัวและเพดานของใบรับรองเสริม'
WHERE code = 'certificate_policy:manage';

-- Down Migration

UPDATE permissions
SET description_th = 'กำหนดนโยบายอายุใบรับรองหลักและเพดานของใบรับรองเสริม'
WHERE code = 'certificate_policy:manage';
