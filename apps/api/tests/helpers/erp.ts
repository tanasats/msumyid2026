import type { ErpStaffInfo } from '../../src/services/erp-hr.js';

/** ข้อมูลบุคลากรที่ ERP-HR ตอบกลับ (พบบุคลากร) — ใช้จำลองการยืนยันตัวบุคลากรตอน login */
export const STAFF_INFO: ErpStaffInfo = {
  staffId: '1234567',
  prefixTh: null,
  firstNameTh: 'สมหญิง',
  lastNameTh: 'ตัวอย่าง',
  prefixEn: null,
  firstNameEn: null,
  lastNameEn: null,
  positionTh: null,
  faculty: null,
  department: null,
  program: null,
};

/** access token ทดสอบ — ต้องมีจึงจะเรียก ERP-HR */
export const ACCESS_TOKEN = 'ya29.test-access-token';
