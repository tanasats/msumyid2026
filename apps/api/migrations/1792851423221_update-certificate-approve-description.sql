-- Up Migration

-- certificate:approve ใช้ตัดสินคำขอใบรับรองประจำตัวด้วย (ตัดสินใจ 2026-10-24) — แก้เฉพาะข้อความ ไม่เปลี่ยน code
UPDATE permissions
SET description_th = 'ดู อนุมัติ และปฏิเสธคำขอใบรับรองประจำตัวและใบรับรองเสริมของผู้อื่น'
WHERE code = 'certificate:approve';

-- Down Migration

UPDATE permissions
SET description_th = 'ดู อนุมัติ และปฏิเสธคำขอใบรับรองเสริมของผู้อื่น'
WHERE code = 'certificate:approve';
