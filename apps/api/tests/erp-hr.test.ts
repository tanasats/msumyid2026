import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { logger } from '../src/middlewares/logger.js';
import { erpHr, parseStaffInfo, type ErpStaffInfo } from '../src/services/erp-hr.js';
import { createUser, loginAs, resetDatabase } from './helpers/db.js';
import * as google from './helpers/google.js';

// mock เฉพาะการเรียกภายนอก (Google, ERP-HR) ฐานข้อมูลใช้ app_test จริง (CLAUDE.md หัวข้อ 15)

const app = createApp();
const ACCESS_TOKEN = 'ya29.test-access-token';

// รหัส ERP ตามตัวอย่างใน docs/erp_hr_msu_staff_info_integration.md
const FACULTY_CODE = '201092700000'; // สำนักงานอธิการบดี (org_units 80)
const DEPARTMENT_CODE = '201092704000'; // กองแผนงาน (org_units 82)

/** ข้อมูลดิบจาก ERP ตามรูปแบบจริง */
function rawStaffInfo(overrides: Record<string, unknown> = {}) {
  return {
    staffid: '1234567',
    prefixid: '003',
    prefixfullname: 'นางสาว',
    namefully: 'สมหญิง ตัวอย่าง',
    staffname: 'สมหญิง',
    staffsurname: 'ตัวอย่าง',
    prefixinitialseng: 'Ms.',
    staffnameeng: 'Somying',
    staffsurnameeng: 'Tuayang',
    posnameth: 'นักวิชาการคอมพิวเตอร์',
    facultyid: FACULTY_CODE,
    facultyname: 'สำนักงานอธิการบดี',
    departmentid: DEPARTMENT_CODE,
    departmentname: 'กองแผนงาน',
    programid: '201092704003',
    programname: 'กลุ่มงานสารสนเทศ',
    staffphone1: '0800000000',
    staffphone2: null,
    staffemail1: 'somying.t@msu.ac.th',
    staffemail2: 'somying.t@msu.ac.th',
    posadid: null,
    adhisposname: null,
    ...overrides,
  };
}

function staffInfo(overrides: Record<string, unknown> = {}): ErpStaffInfo {
  return parseStaffInfo(rawStaffInfo(overrides));
}

/** login บุคลากรด้วย Google (มี access token) โดย ERP ตอบตามที่กำหนด */
async function loginStaff(
  erp: ErpStaffInfo | null | Error,
  overrides: Parameters<typeof google.identity>[0] = {},
) {
  const fetchStaffInfo = vi.spyOn(erpHr, 'fetchStaffInfo');
  if (erp instanceof Error) fetchStaffInfo.mockRejectedValue(erp);
  else fetchStaffInfo.mockResolvedValue(erp);
  const result = await google.loginWith(app, {
    email: 'somying.t@msu.ac.th',
    name: 'Somying T.',
    accessToken: ACCESS_TOKEN,
    ...overrides,
  });
  return { ...result, fetchStaffInfo };
}

async function userRow() {
  const { rows } = await pool.query<{ name: string; display_name: string; org_unit_code: string | null }>(
    `SELECT u.name, u.display_name, ou.code AS org_unit_code
     FROM users u LEFT JOIN org_units ou ON ou.id = u.org_unit_id`,
  );
  return rows[0]!;
}

async function erpOrgUnits() {
  const { rows } = await pool.query(
    `SELECT e.erp_code, e.level, e.match_type, ou.code AS org_unit_code
     FROM erp_org_units e LEFT JOIN org_units ou ON ou.id = e.org_unit_id
     ORDER BY e.erp_code`,
  );
  return rows;
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('parseStaffInfo', () => {
  it('แปลงข้อมูลจาก ERP ครบทุกช่องที่ระบบเก็บ', () => {
    expect(staffInfo()).toEqual({
      staffId: '1234567',
      prefixTh: 'นางสาว',
      firstNameTh: 'สมหญิง',
      lastNameTh: 'ตัวอย่าง',
      prefixEn: 'Ms.',
      firstNameEn: 'Somying',
      lastNameEn: 'Tuayang',
      positionTh: 'นักวิชาการคอมพิวเตอร์',
      faculty: { erpCode: FACULTY_CODE, nameTh: 'สำนักงานอธิการบดี' },
      department: { erpCode: DEPARTMENT_CODE, nameTh: 'กองแผนงาน' },
      program: { code: '201092704003', nameTh: 'กลุ่มงานสารสนเทศ' },
    });
  });

  it('ไม่นำเบอร์โทรศัพท์และอีเมลสำรองเข้าระบบ (PDPA)', () => {
    const text = JSON.stringify(staffInfo());
    expect(text).not.toContain('0800000000');
    expect(text).not.toContain('somying.t@msu.ac.th');
  });

  it('ข้อความว่าง/null → null และตัดช่องว่างหัวท้าย', () => {
    const info = staffInfo({ staffname: '  สมหญิง ', posnameth: '', staffnameeng: null, prefixfullname: '   ' });
    expect(info.firstNameTh).toBe('สมหญิง');
    expect(info.positionTh).toBeNull();
    expect(info.firstNameEn).toBeNull();
    expect(info.prefixTh).toBeNull();
  });

  it('รหัสหน่วยงานไม่ใช่ 12 หลัก หรือไม่มีชื่อ → ไม่ใช้หน่วยงานนั้น', () => {
    const info = staffInfo({ facultyid: '2010927', departmentname: null, programname: '' });
    expect(info.faculty).toBeNull();
    expect(info.department).toBeNull();
    expect(info.program).toBeNull();
  });

  it('ไม่มีรหัสบุคลากรหรือชื่อ-นามสกุล → throw', () => {
    expect(() => parseStaffInfo(rawStaffInfo({ staffid: '' }))).toThrow();
    expect(() => parseStaffInfo(rawStaffInfo({ staffsurname: null }))).toThrow();
  });
});

describe('erpHr.fetchStaffInfo', () => {
  function mockFetch(status: number, body: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    );
  }

  it('ส่ง Google access token แบบ Bearer ไปที่ URL จาก config', async () => {
    const fetchMock = mockFetch(200, { status: true, message: 'Success', data: rawStaffInfo() });
    const info = await erpHr.fetchStaffInfo(ACCESS_TOKEN);

    expect(info?.staffId).toBe('1234567');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(process.env.ERP_HR_STAFFINFO_URL);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('ERP ตอบ status: false (ไม่พบบุคลากร) → null', async () => {
    mockFetch(200, { status: false, message: 'Not found' });
    expect(await erpHr.fetchStaffInfo(ACCESS_TOKEN)).toBeNull();
  });

  it('HTTP error → throw', async () => {
    mockFetch(500, { message: 'error' });
    await expect(erpHr.fetchStaffInfo(ACCESS_TOKEN)).rejects.toThrow('HTTP 500');
  });
});

describe('login บุคลากรพร้อมดึงข้อมูล ERP-HR', () => {
  it('เก็บข้อมูลบุคลากร ใช้ชื่อไทยจาก ERP (ไม่มีคำนำหน้า) เป็นชื่อแสดง', async () => {
    const { res, fetchStaffInfo } = await loginStaff(staffInfo());
    expect(res.headers.location).toBe('http://localhost:3010');
    expect(fetchStaffInfo).toHaveBeenCalledWith(ACCESS_TOKEN);

    const user = await userRow();
    expect(user.name).toBe('Somying T.'); // ชื่อจาก Google ยังเก็บไว้
    expect(user.display_name).toBe('สมหญิง ตัวอย่าง');

    const { rows } = await pool.query(
      `SELECT staff_id, prefix_th, first_name_th, last_name_th, prefix_en, first_name_en, last_name_en,
              position_th, program_erp_code, program_name_th
       FROM staff_profiles`,
    );
    expect(rows).toEqual([
      {
        staff_id: '1234567',
        prefix_th: 'นางสาว',
        first_name_th: 'สมหญิง',
        last_name_th: 'ตัวอย่าง',
        prefix_en: 'Ms.',
        first_name_en: 'Somying',
        last_name_en: 'Tuayang',
        position_th: 'นักวิชาการคอมพิวเตอร์',
        program_erp_code: '201092704003',
        program_name_th: 'กลุ่มงานสารสนเทศ',
      },
    ]);
  });

  it('GET /auth/me คืนชื่อแสดงจาก ERP', async () => {
    const { res } = await loginStaff(staffInfo());
    const cookie = google.sessionCookieFrom(res)!.split(';')[0]!;
    const me = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(me.body.user.name).toBe('สมหญิง ตัวอย่าง');
  });

  it('จับคู่หน่วยงาน ERP กับ org_units จากชื่ออัตโนมัติ และใช้ระดับกอง/ฝ่ายเป็นหน่วยงานของบุคลากร', async () => {
    await loginStaff(staffInfo());
    expect(await erpOrgUnits()).toEqual([
      { erp_code: FACULTY_CODE, level: 'faculty', match_type: 'auto', org_unit_code: '80' },
      { erp_code: DEPARTMENT_CODE, level: 'department', match_type: 'auto', org_unit_code: '82' },
    ]);
    expect((await userRow()).org_unit_code).toBe('82');
  });

  it('กอง/ฝ่ายจับคู่ไม่ได้ → ใช้หน่วยงานของคณะ/สำนักแทน', async () => {
    await loginStaff(staffInfo({ departmentname: 'หน่วยงานที่ไม่มีในระบบ' }));
    const units = await erpOrgUnits();
    expect(units[1]).toEqual({
      erp_code: DEPARTMENT_CODE,
      level: 'department',
      match_type: null,
      org_unit_code: null,
    });
    expect((await userRow()).org_unit_code).toBe('80');
  });

  it('การจับคู่แบบ manual ไม่ถูกทับ และใช้เป็นหน่วยงานของบุคลากร', async () => {
    await pool.query(
      `INSERT INTO erp_org_units (erp_code, name_th, level, org_unit_id, match_type)
       VALUES ($1, 'กองแผนงาน', 'department', (SELECT id FROM org_units WHERE code = '25'), 'manual')`,
      [DEPARTMENT_CODE],
    );
    await loginStaff(staffInfo());

    const department = (await erpOrgUnits()).find((u) => u.erp_code === DEPARTMENT_CODE);
    expect(department).toMatchObject({ match_type: 'manual', org_unit_code: '25' });
    expect((await userRow()).org_unit_code).toBe('25');
  });

  it('ชื่อหน่วยงานใน ERP เปลี่ยน → อัปเดตชื่อและจับคู่ auto ใหม่', async () => {
    const sub = 'google-rename';
    await loginStaff(staffInfo(), { sub });
    await loginStaff(staffInfo({ departmentname: 'กองการเจ้าหน้าที่' }), { sub });

    const { rows } = await pool.query(`SELECT name_th FROM erp_org_units WHERE erp_code = $1`, [DEPARTMENT_CODE]);
    expect(rows[0]!.name_th).toBe('กองการเจ้าหน้าที่');
    expect((await userRow()).org_unit_code).toBe('83');
  });

  it('ERP ล่มตอน login ครั้งแรก → login ผ่าน ใช้ชื่อจาก Google และไม่มีข้อมูลบุคลากร', async () => {
    const { res } = await loginStaff(new Error('fetch failed'));
    expect(res.headers.location).toBe('http://localhost:3010');
    expect(google.sessionCookieFrom(res)).toBeDefined();
    expect((await userRow()).display_name).toBe('Somying T.');
    const { rows } = await pool.query(`SELECT 1 FROM staff_profiles`);
    expect(rows).toHaveLength(0);
  });

  it('ERP ล่มใน login ครั้งถัดไป → คงชื่อและข้อมูลบุคลากรเดิมไว้', async () => {
    const sub = 'google-erp-down';
    await loginStaff(staffInfo(), { sub });
    const { res } = await loginStaff(new Error('TimeoutError'), { sub, name: 'Google ชื่อใหม่' });

    expect(google.sessionCookieFrom(res)).toBeDefined();
    const user = await userRow();
    expect(user.name).toBe('Google ชื่อใหม่');
    expect(user.display_name).toBe('สมหญิง ตัวอย่าง');
    expect(user.org_unit_code).toBe('82');
  });

  it('ERP ไม่พบบุคลากร (null) → login ผ่านด้วยชื่อจาก Google', async () => {
    const { res } = await loginStaff(null);
    expect(google.sessionCookieFrom(res)).toBeDefined();
    expect((await userRow()).display_name).toBe('Somying T.');
  });

  it('ข้อมูลใน ERP เปลี่ยน → อัปเดตข้อมูลบุคลากรและชื่อแสดงตาม', async () => {
    const sub = 'google-erp-update';
    await loginStaff(staffInfo(), { sub });
    await loginStaff(staffInfo({ staffsurname: 'นามสกุลใหม่', posnameth: 'ผู้อำนวยการกอง' }), { sub });

    expect((await userRow()).display_name).toBe('สมหญิง นามสกุลใหม่');
    const { rows } = await pool.query(`SELECT last_name_th, position_th FROM staff_profiles`);
    expect(rows).toEqual([{ last_name_th: 'นามสกุลใหม่', position_th: 'ผู้อำนวยการกอง' }]);
  });

  it('ไม่เรียก ERP กับนิสิตและบุคลากรภายนอก — ชื่อแสดงใช้ชื่อจาก Google', async () => {
    const fetchStaffInfo = vi.spyOn(erpHr, 'fetchStaffInfo');
    await google.loginWith(app, { email: '64011212345@msu.ac.th', name: 'นิสิต ทดสอบ', accessToken: ACCESS_TOKEN });
    await google.loginWith(app, { email: 'someone@gmail.com', hd: null, accessToken: ACCESS_TOKEN });
    expect(fetchStaffInfo).not.toHaveBeenCalled();

    const { rows } = await pool.query(`SELECT display_name FROM users ORDER BY created_at`);
    expect(rows.map((r) => r.display_name)).toEqual(['นิสิต ทดสอบ', 'สมชาย ใจดี']);
  });

  it('ไม่ log access token เมื่อ ERP ล้มเหลว', async () => {
    const warn = vi.spyOn(logger, 'warn');
    await loginStaff(new Error('fetch failed'));
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ACCESS_TOKEN);
  });
});

describe('GET /me/staff-profile', () => {
  it('ยังไม่ login → 401', async () => {
    const res = await request(app).get('/me/staff-profile');
    expect(res.status).toBe(401);
  });

  it('บัญชีรออนุมัติ → 403', async () => {
    const user = await createUser({ accountType: 'external', approvalStatus: 'pending' });
    const res = await request(app).get('/me/staff-profile').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(403);
  });

  it('ไม่ใช่บุคลากร หรือยังไม่เคยดึง ERP สำเร็จ → staffProfile: null', async () => {
    const user = await createUser({ accountType: 'student' });
    const res = await request(app).get('/me/staff-profile').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ staffProfile: null });
  });

  it('คืนข้อมูลบุคลากรของตัวเอง พร้อมชื่อคณะ กอง และหน่วยงานในระบบ', async () => {
    const { res: login } = await loginStaff(staffInfo());
    const cookie = google.sessionCookieFrom(login)!.split(';')[0]!;
    // บุคลากรอีกคน — ต้องไม่ปนมา
    const other = await createUser();
    await pool.query(
      `INSERT INTO staff_profiles (user_id, staff_id, first_name_th, last_name_th, synced_at)
       VALUES ($1, '9999999', 'คนอื่น', 'ทดสอบ', now())`,
      [other.id],
    );

    const res = await request(app).get('/me/staff-profile').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.staffProfile).toMatchObject({
      staffId: '1234567',
      firstNameTh: 'สมหญิง',
      lastNameTh: 'ตัวอย่าง',
      positionTh: 'นักวิชาการคอมพิวเตอร์',
      facultyNameTh: 'สำนักงานอธิการบดี',
      departmentNameTh: 'กองแผนงาน',
      programNameTh: 'กลุ่มงานสารสนเทศ',
      orgUnitNameTh: 'กองแผนงาน',
    });
  });
});
