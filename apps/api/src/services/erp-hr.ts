import { z } from 'zod';
import { config } from '../config/index.js';

// จุดเดียวที่คุยกับ ERP-HR — test mock เฉพาะ object นี้ (CLAUDE.md หัวข้อ 15)
// รายละเอียด API: docs/erp_hr_msu_staff_info_integration.md

/** ข้อมูลบุคลากรที่ระบบเก็บ (ไม่รวมเบอร์โทรศัพท์และอีเมลสำรอง — PDPA) */
export type ErpStaffInfo = {
  staffId: string;
  prefixTh: string | null;
  firstNameTh: string;
  lastNameTh: string;
  prefixEn: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  positionTh: string | null;
  faculty: ErpOrgUnitRef | null;
  department: ErpOrgUnitRef | null;
  program: { code: string; nameTh: string } | null;
};

export type ErpOrgUnitRef = { erpCode: string; nameTh: string };

// ข้อความว่างหรือ null จาก ERP → null
const optionalText = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);

// รหัสหน่วยงาน ERP 12 หลัก — ถ้ารูปแบบผิดถือว่าไม่มี (ไม่ทำให้ทั้งข้อมูลใช้ไม่ได้)
const orgUnitCode = z
  .string()
  .nullish()
  .transform((v) => (v && /^[0-9]{12}$/.test(v.trim()) ? v.trim() : null));

const staffInfoSchema = z.object({
  staffid: z.string().trim().min(1),
  prefixfullname: optionalText,
  staffname: z.string().trim().min(1),
  staffsurname: z.string().trim().min(1),
  prefixinitialseng: optionalText,
  staffnameeng: optionalText,
  staffsurnameeng: optionalText,
  posnameth: optionalText,
  facultyid: orgUnitCode,
  facultyname: optionalText,
  departmentid: orgUnitCode,
  departmentname: optionalText,
  programid: optionalText,
  programname: optionalText,
});

const responseSchema = z.object({
  status: z.boolean(),
  data: z.unknown().optional(),
});

/** หน่วยงานต้องมีทั้งรหัสและชื่อ จึงจะนำไปใช้ */
function orgRef(code: string | null, name: string | null): ErpOrgUnitRef | null {
  return code && name ? { erpCode: code, nameTh: name } : null;
}

/** แปลงข้อมูลดิบจาก ERP เป็นรูปแบบของระบบ — throw ถ้าข้อมูลจำเป็นไม่ครบ */
export function parseStaffInfo(raw: unknown): ErpStaffInfo {
  const d = staffInfoSchema.parse(raw);
  return {
    staffId: d.staffid,
    prefixTh: d.prefixfullname,
    firstNameTh: d.staffname,
    lastNameTh: d.staffsurname,
    prefixEn: d.prefixinitialseng,
    firstNameEn: d.staffnameeng,
    lastNameEn: d.staffsurnameeng,
    positionTh: d.posnameth,
    faculty: orgRef(d.facultyid, d.facultyname),
    department: orgRef(d.departmentid, d.departmentname),
    program: d.programid && d.programname ? { code: d.programid, nameTh: d.programname } : null,
  };
}

export const erpHr = {
  /**
   * ดึงข้อมูลบุคลากรของเจ้าของ Google access token
   * - คืน null เมื่อ ERP ตอบว่าไม่พบข้อมูล (status: false) เช่น บัญชีที่ไม่ใช่บุคลากรในระบบ HR
   * - throw เมื่อเรียกไม่สำเร็จ (timeout, HTTP error, รูปแบบข้อมูลผิด) ให้ผู้เรียกตัดสินใจ
   * access token ใช้ส่งใน header เท่านั้น ห้ามเก็บหรือ log (CLAUDE.md หัวข้อ 18)
   */
  async fetchStaffInfo(accessToken: string): Promise<ErpStaffInfo | null> {
    const res = await fetch(config.erpHr.staffInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(config.erpHr.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`ERP-HR ตอบ HTTP ${res.status}`);
    }
    const body = responseSchema.parse(await res.json());
    if (!body.status) return null;
    return parseStaffInfo(body.data);
  },
};
