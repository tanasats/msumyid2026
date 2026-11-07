import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { upsertErpOrgUnit } from '../src/repositories/erp-org-unit-repository.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// หน้าจับคู่หน่วยงาน ERP แบบกำหนดเอง (/admin/org-units, CLAUDE.md หัวข้อ 18) — ฐานข้อมูลจริง app_test
// การที่ login ไม่ทับการจับคู่ manual ทดสอบไว้แล้วใน erp-hr.test.ts

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.query(`DELETE FROM org_units WHERE code = '99'`);
  await pool.end();
});

const send = (method: 'put' | 'delete', path: string, cookie: string, body: object) =>
  request(app)[method](path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

const orgUnitId = async (code: string) =>
  (await pool.query<{ id: string }>(`SELECT id FROM org_units WHERE code = $1`, [code])).rows[0]!.id;

/** หน่วยงาน ERP ผ่าน upsertErpOrgUnit จริง (จับคู่จากชื่อเหมือนตอน login) คืน id */
async function erpUnit(erpCode: string, nameTh: string, level: 'faculty' | 'department') {
  await upsertErpOrgUnit(pool, { erpCode, nameTh, level });
  return (await pool.query<{ id: string }>(`SELECT id FROM erp_org_units WHERE erp_code = $1`, [erpCode])).rows[0]!.id;
}

/** บุคลากรที่ ERP ระบุคณะ/กอง (org_unit_id เริ่มต้นตามที่ส่งมา) */
async function staffIn(faculty: string | null, department: string | null, orgUnit: string | null = null) {
  const user = await createUser({ roles: ['user', 'staff'], orgUnitId: orgUnit });
  await pool.query(
    `INSERT INTO staff_profiles (user_id, staff_id, first_name_th, last_name_th,
                                 faculty_erp_org_unit_id, department_erp_org_unit_id, synced_at)
     VALUES ($1, '1', 'ทดสอบ', 'ระบบ', $2, $3, now())`,
    [user.id, faculty, department],
  );
  return user.id;
}

const userOrgUnit = async (userId: string) =>
  (await pool.query<{ id: string | null }>(`SELECT org_unit_id AS id FROM users WHERE id = $1`, [userId])).rows[0]!.id;

const mapping = async (id: string) =>
  (
    await pool.query<{ orgUnitId: string | null; matchType: string | null }>(
      `SELECT org_unit_id AS "orgUnitId", match_type AS "matchType" FROM erp_org_units WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

describe('สิทธิ์ org_unit:manage', () => {
  it('ไม่มีสิทธิ์ = 403 ทุก endpoint / role ที่ผูก org_unit:manage ใช้ได้ / super_admin ใช้ได้', async () => {
    const unit = await erpUnit('100000000001', 'ชื่อที่ไม่ตรง', 'faculty');
    const target = await orgUnitId('12');
    const plain = await loginAs((await createUser()).id);
    expect((await request(app).get('/admin/erp-org-units').set('Cookie', plain)).status).toBe(403);
    expect((await request(app).get(`/admin/erp-org-units/${unit}/logs`).set('Cookie', plain)).status).toBe(403);
    const body = { orgUnitId: target, reason: 'x' };
    expect((await send('put', `/admin/erp-org-units/${unit}/mapping`, plain, body)).status).toBe(403);
    expect((await send('delete', `/admin/erp-org-units/${unit}/mapping`, plain, { reason: 'x' })).status).toBe(403);

    await createTestRole('test_org_manager', ['org_unit:manage']);
    const manager = await loginAs((await createUser({ roles: ['user', 'staff', 'test_org_manager'] })).id);
    const list = await request(app).get('/admin/erp-org-units').set('Cookie', manager);
    expect(list.status).toBe(200);
    // ตัวเลือกหน่วยงานมากับรายการ (ไม่ต้องมี user:read)
    expect(list.body.orgUnits.length).toBeGreaterThan(0);
    expect((await send('put', `/admin/erp-org-units/${unit}/mapping`, manager, body)).status).toBe(200);

    const admin = await superAdmin();
    expect((await request(app).get('/admin/erp-org-units').set('Cookie', admin.cookie)).status).toBe(200);
  });

  it('ต้องยืนยันตัวตนซ้ำก่อนเปลี่ยน (login นานแล้ว = RECENT_LOGIN_REQUIRED, ไม่เปลี่ยนอะไร)', async () => {
    const unit = await erpUnit('100000000001', 'ชื่อที่ไม่ตรง', 'faculty');
    const admin = await superAdmin();
    await pool.query(`UPDATE sessions SET created_at = now() - interval '1 hour' WHERE user_id = $1`, [admin.id]);
    const res = await send('put', `/admin/erp-org-units/${unit}/mapping`, admin.cookie, {
      orgUnitId: await orgUnitId('12'),
      reason: 'x',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('RECENT_LOGIN_REQUIRED');
    expect(await mapping(unit)).toEqual({ orgUnitId: null, matchType: null });
    // ดูรายการไม่ต้องยืนยันซ้ำ
    expect((await request(app).get('/admin/erp-org-units').set('Cookie', admin.cookie)).status).toBe(200);
  });
});

describe('รายการหน่วยงาน ERP', () => {
  it('ค่าเริ่มต้น = ยังไม่จับคู่ เรียงตามจำนวนบุคลากร / ตัวกรองสถานะ ระดับ และคำค้น', async () => {
    const few = await erpUnit('100000000001', 'หน่วยงานไม่ตรง ก', 'faculty');
    const many = await erpUnit('100000000002', 'หน่วยงานไม่ตรง ข', 'department');
    const auto = await erpUnit('100000000003', 'คณะวิทยาการสารสนเทศ', 'faculty');
    await staffIn(few, null);
    await staffIn(null, many);
    await staffIn(auto, many);
    const admin = await superAdmin();
    const get = (query: string) => request(app).get(`/admin/erp-org-units${query}`).set('Cookie', admin.cookie);

    const res = await get('');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, unmatchedCount: 2 });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([many, few]);
    expect(res.body.items[0]).toMatchObject({ erpCode: '100000000002', staffCount: 2, matchType: null, orgUnit: null });

    const autoRes = await get('?status=auto');
    expect(autoRes.body.items).toHaveLength(1);
    expect(autoRes.body.items[0]).toMatchObject({ id: auto, matchType: 'auto', orgUnit: { code: '12' }, staffCount: 1 });

    expect((await get('?status=all&level=department')).body.items.map((i: { id: string }) => i.id)).toEqual([many]);
    expect((await get('?status=all&q=' + encodeURIComponent('ไม่ตรง ก'))).body.items.map((i: { id: string }) => i.id)).toEqual([few]);
    expect((await get('?status=all&q=100000000003')).body.items.map((i: { id: string }) => i.id)).toEqual([auto]);
    expect((await get('?status=bogus')).status).toBe(400);
  });
});

describe('กำหนดหน่วยงานเอง (PUT)', () => {
  it('จับคู่แล้วหน่วยงานของบุคลากรเปลี่ยนทันที — คนที่กองจับคู่แล้วไม่ถูกทับด้วยคณะ + log', async () => {
    const faculty = await erpUnit('100000000001', 'คณะที่ชื่อไม่ตรง', 'faculty');
    const department = await erpUnit('100000000002', 'กองแผนงาน', 'department'); // auto → 82
    const plan = await orgUnitId('82');
    const onlyFaculty = await staffIn(faculty, null);
    const withDepartment = await staffIn(faculty, department, plan);
    // บัญชีที่ไม่ใช่บุคลากร (เช่น เปลี่ยนเป็นบัญชีหน่วยงานแล้ว) ไม่ถูกแก้
    const service = await staffIn(faculty, null);
    await pool.query(`UPDATE users SET account_type = 'service' WHERE id = $1`, [service]);

    const admin = await superAdmin();
    const target = await orgUnitId('12');
    const res = await send('put', `/admin/erp-org-units/${faculty}/mapping`, admin.cookie, {
      orgUnitId: target,
      reason: 'ชื่อใน ERP สะกดต่างจากระบบ',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ affectedUsers: 1 });
    expect(await mapping(faculty)).toEqual({ orgUnitId: target, matchType: 'manual' });
    expect(await userOrgUnit(onlyFaculty)).toBe(target);
    expect(await userOrgUnit(withDepartment)).toBe(plan);
    expect(await userOrgUnit(service)).toBeNull();

    // login ครั้งถัดไป ERP ส่งชื่อเดิมมา → ไม่ทับ manual
    await upsertErpOrgUnit(pool, { erpCode: '100000000001', nameTh: 'คณะที่ชื่อไม่ตรง', level: 'faculty' });
    expect(await mapping(faculty)).toEqual({ orgUnitId: target, matchType: 'manual' });

    const logs = await request(app).get(`/admin/erp-org-units/${faculty}/logs`).set('Cookie', admin.cookie);
    expect(logs.body.logs).toHaveLength(1);
    expect(logs.body.logs[0]).toMatchObject({
      action: 'set_manual',
      actor: { id: admin.id },
      from: { orgUnitName: null, matchType: null },
      to: { orgUnitName: 'คณะวิทยาการสารสนเทศ', matchType: 'manual' },
      reason: 'ชื่อใน ERP สะกดต่างจากระบบ',
      affectedUsers: 1,
    });
  });

  it('เปลี่ยนกองที่ระบบจับคู่ผิด → คนในกองย้ายหน่วยงาน / ค่าเดิม = 409 / ไม่พบ = 404 / หน่วยงานปิด = 422', async () => {
    const department = await erpUnit('100000000002', 'กองแผนงาน', 'department');
    const person = await staffIn(null, department, await orgUnitId('82'));
    const admin = await superAdmin();
    const target = await orgUnitId('25');
    const path = `/admin/erp-org-units/${department}/mapping`;

    expect((await send('put', path, admin.cookie, { orgUnitId: target, reason: 'ย้ายสังกัด' })).body).toEqual({
      affectedUsers: 1,
    });
    expect(await userOrgUnit(person)).toBe(target);

    const same = await send('put', path, admin.cookie, { orgUnitId: target, reason: 'ซ้ำ' });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('MAPPING_UNCHANGED');

    const missing = await send('put', `/admin/erp-org-units/${crypto.randomUUID()}/mapping`, admin.cookie, {
      orgUnitId: target,
      reason: 'x',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ERP_ORG_UNIT_NOT_FOUND');

    const inactive = (
      await pool.query<{ id: string }>(
        `INSERT INTO org_units (code, name_th, is_active) VALUES ('99', 'หน่วยงานที่ปิดแล้ว', false)
         ON CONFLICT (code) DO UPDATE SET is_active = false RETURNING id`,
      )
    ).rows[0]!.id;
    const closed = await send('put', path, admin.cookie, { orgUnitId: inactive, reason: 'x' });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('ORG_UNIT_INACTIVE');

    expect((await send('put', path, admin.cookie, { orgUnitId: target, reason: '   ' })).status).toBe(400);
    // ที่ไม่สำเร็จไม่มี log
    const { rows } = await pool.query(`SELECT 1 FROM erp_org_unit_mapping_logs WHERE erp_org_unit_id = $1`, [department]);
    expect(rows).toHaveLength(1);
  });
});

describe('คืนให้ระบบจับคู่ (DELETE)', () => {
  it('manual → จับคู่จากชื่อใหม่ (ตรง = auto, ไม่ตรง = ยังไม่จับคู่) และหน่วยงานของบุคลากรตามไป', async () => {
    const admin = await superAdmin();
    const plan = await orgUnitId('82');
    const matching = await erpUnit('100000000002', 'กองแผนงาน', 'department');
    const unmatched = await erpUnit('100000000001', 'ชื่อที่ไม่ตรง', 'faculty');
    const a = await staffIn(null, matching, plan);
    const b = await staffIn(unmatched, null);
    for (const unit of [matching, unmatched]) {
      await send('put', `/admin/erp-org-units/${unit}/mapping`, admin.cookie, {
        orgUnitId: await orgUnitId('25'),
        reason: 'ทดสอบ',
      });
    }

    const back = await send('delete', `/admin/erp-org-units/${matching}/mapping`, admin.cookie, { reason: 'ใช้ชื่อตาม ERP' });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ affectedUsers: 1, matched: true });
    expect(await mapping(matching)).toEqual({ orgUnitId: plan, matchType: 'auto' });
    expect(await userOrgUnit(a)).toBe(plan);

    const none = await send('delete', `/admin/erp-org-units/${unmatched}/mapping`, admin.cookie, { reason: 'ยกเลิก' });
    expect(none.body).toEqual({ affectedUsers: 1, matched: false });
    expect(await mapping(unmatched)).toEqual({ orgUnitId: null, matchType: null });
    expect(await userOrgUnit(b)).toBeNull();

    const logs = await request(app).get(`/admin/erp-org-units/${unmatched}/logs`).set('Cookie', admin.cookie);
    expect(logs.body.logs[0]).toMatchObject({
      action: 'reset_auto',
      from: { orgUnitName: 'สำนักคอมพิวเตอร์', matchType: 'manual' },
      to: { orgUnitName: null, matchType: null },
    });

    // ไม่ได้กำหนดเอง = 409
    const again = await send('delete', `/admin/erp-org-units/${matching}/mapping`, admin.cookie, { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MAPPING_NOT_MANUAL');
  });
});

describe('ประวัติ', () => {
  it('ไม่พบหน่วยงาน = 404 / log แก้หรือลบไม่ได้', async () => {
    const admin = await superAdmin();
    expect((await request(app).get(`/admin/erp-org-units/${crypto.randomUUID()}/logs`).set('Cookie', admin.cookie)).status).toBe(404);

    const unit = await erpUnit('100000000001', 'ชื่อที่ไม่ตรง', 'faculty');
    await send('put', `/admin/erp-org-units/${unit}/mapping`, admin.cookie, { orgUnitId: await orgUnitId('12'), reason: 'x' });
    await expect(pool.query(`UPDATE erp_org_unit_mapping_logs SET reason = 'แก้'`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM erp_org_unit_mapping_logs`)).rejects.toThrow();
  });
});
