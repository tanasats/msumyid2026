-- Up Migration

-- certificate:revoke ครอบคลุมการอนุมัติ/ปฏิเสธคำขอเพิกถอนใบรับรองประจำตัวด้วย (ตัดสินใจ 2026-10-29)
-- อนุมัติคำขอ = เพิกถอนใบของผู้อื่น จึงใช้ permission เดิม — แก้เฉพาะข้อความ ไม่เปลี่ยน code
UPDATE permissions
SET description_th = 'เพิกถอนใบรับรองของผู้อื่น และอนุมัติ/ปฏิเสธคำขอเพิกถอนใบรับรอง'
WHERE code = 'certificate:revoke';

-- Down Migration

UPDATE permissions
SET description_th = 'เพิกถอนใบรับรองของผู้อื่น'
WHERE code = 'certificate:revoke';
