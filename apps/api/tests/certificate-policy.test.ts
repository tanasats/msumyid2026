import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import type { CertificatePolicySettings } from '../src/repositories/certificate-policy-repository.js';
import { primaryValidityDays } from '../src/services/certificate-policy-service.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// นโยบายอายุใบรับรอง: คำนวณอายุใบประจำตัว + หน้าผู้ดูแล (certificate_policy:manage)

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: CertificatePolicySettings = {
  primaryMode: 'days',
  primaryDays: 365,
  primaryExpiryMonth: 12,
  primaryExpiryDay: 31,
  primaryMinDays: 60,
  renewalWindowDays: 30,
  supplementaryMaxDays: 90,
  supplementaryMaxActive: 3,
};

const fixedDate = (input: Partial<CertificatePolicySettings> = {}): CertificatePolicySettings => ({
  ...DEFAULTS,
  primaryMode: 'fixed_date',
  ...input,
});

/** วันที่ตามเวลาประเทศไทย (YYYY-MM-DD) */
const bangkokDate = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('primaryValidityDays', () => {
  it('โหมด days → ตามจำนวนวันที่กำหนด', () => {
    expect(primaryValidityDays({ ...DEFAULTS, primaryDays: 180 }, new Date())).toBe(180);
  });

  it('โหมด fixed_date → หมดอายุ 31 ธ.ค. ของปีนี้ (เวลาประเทศไทย)', () => {
    const now = new Date('2026-10-24T03:00:00Z'); // 10:00 น. เวลาไทย
    const days = primaryValidityDays(fixedDate(), now);
    expect(days).toBe(68);
    expect(bangkokDate(new Date(now.getTime() + days * DAY))).toBe('2026-12-31');
  });

  it('เหลือน้อยกว่าอายุขั้นต่ำ → ข้ามไป 31 ธ.ค. ของปีถัดไป', () => {
    const now = new Date('2026-11-15T03:00:00Z');
    const days = primaryValidityDays(fixedDate({ primaryMinDays: 60 }), now);
    expect(bangkokDate(new Date(now.getTime() + days * DAY))).toBe('2027-12-31');
  });

  it('อายุขั้นต่ำ 0 แต่เหลือไม่ถึง 1 วัน (ขอเย็นวันที่ 31 ธ.ค.) → ปีถัดไป', () => {
    const now = new Date('2026-12-31T13:00:00Z'); // 20:00 น. เวลาไทย
    const days = primaryValidityDays(fixedDate({ primaryMinDays: 0 }), now);
    expect(days).toBe(365);
    expect(bangkokDate(new Date(now.getTime() + days * DAY))).toBe('2027-12-31');
  });

  it('ใช้ปีตามเวลาประเทศไทย: 1 ม.ค. 01:00 น. ไทย (ยังเป็น 31 ธ.ค. ใน UTC) → 31 ธ.ค. ของปีใหม่', () => {
    const now = new Date('2026-12-31T18:00:00Z');
    const days = primaryValidityDays(fixedDate({ primaryMinDays: 0 }), now);
    expect(bangkokDate(new Date(now.getTime() + days * DAY))).toBe('2027-12-31');
  });

  it('วันที่อื่นที่ไม่ใช่สิ้นปี (30 มิ.ย.)', () => {
    const now = new Date('2026-10-24T03:00:00Z');
    const days = primaryValidityDays(fixedDate({ primaryExpiryMonth: 6, primaryExpiryDay: 30 }), now);
    expect(bangkokDate(new Date(now.getTime() + days * DAY))).toBe('2027-06-30');
  });
});

async function admin() {
  const user = await createUser({ roles: ['user', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const put = (cookie: string, body: object) =>
  request(app).put('/admin/certificate-policy').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

describe('GET/PUT /admin/certificate-policy (certificate_policy:manage)', () => {
  it('ยังไม่ login → 401 / ไม่มี permission → 403', async () => {
    expect((await request(app).get('/admin/certificate-policy')).status).toBe(401);
    const user = await createUser({ roles: ['user', 'staff'] });
    const cookie = await loginAs(user.id);
    expect((await request(app).get('/admin/certificate-policy').set('Cookie', cookie)).status).toBe(403);
    expect((await put(cookie, DEFAULTS)).status).toBe(403);
  });

  it('role ที่ผูก permission นี้เข้าได้ (ไม่ต้องเป็น super_admin)', async () => {
    await createTestRole('test_policy', ['certificate_policy:manage']);
    const user = await createUser({ roles: ['user', 'test_policy'] });
    const res = await request(app).get('/admin/certificate-policy').set('Cookie', await loginAs(user.id));
    expect(res.status).toBe(200);
  });

  it('ค่าเริ่มต้นจาก migration: ใบประจำตัว 365 วัน ต่ออายุได้เมื่อเหลือ 30 วัน', async () => {
    const { cookie } = await admin();
    const res = await request(app).get('/admin/certificate-policy').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({ ...DEFAULTS, updatedBy: null });
    expect(res.body.logs).toEqual([]);
    expect(Date.parse(res.body.primaryExpiryPreview)).toBeGreaterThan(Date.now() + 364 * DAY);
  });

  it('แก้นโยบาย → ค่าใหม่ + ผู้แก้ + ประวัติค่าก่อน/หลัง', async () => {
    const actor = await admin();
    const next = fixedDate({ primaryMinDays: 45, renewalWindowDays: 14, supplementaryMaxDays: 30 });

    const res = await put(actor.cookie, next);
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({ ...next, updatedBy: { id: actor.id } });
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]).toMatchObject({ actor: { id: actor.id }, before: DEFAULTS, after: next });
    expect(bangkokDate(new Date(res.body.primaryExpiryPreview))).toMatch(/-12-31$/);
  });

  it('วันที่ไม่มีในเดือน (30 ก.พ., 31 เม.ย.) → 422 POLICY_INVALID และไม่บันทึก', async () => {
    const { cookie } = await admin();
    for (const [month, day] of [
      [2, 29],
      [4, 31],
    ]) {
      const res = await put(cookie, fixedDate({ primaryExpiryMonth: month, primaryExpiryDay: day }));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('POLICY_INVALID');
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM certificate_policy_logs');
    expect(rows[0].n).toBe(0);
  });

  it('ช่วงต่ออายุไม่สั้นกว่าอายุใบประจำตัว → 422 (ไม่เช่นนั้นขอใบประจำตัวใหม่ได้ตลอด)', async () => {
    const { cookie } = await admin();
    expect((await put(cookie, { ...DEFAULTS, primaryDays: 30, renewalWindowDays: 30 })).status).toBe(422);
    expect((await put(cookie, fixedDate({ primaryMinDays: 20, renewalWindowDays: 30 }))).status).toBe(422);
  });

  it('ค่านอกช่วง / ขาดฟิลด์ → 400', async () => {
    const { cookie } = await admin();
    expect((await put(cookie, { ...DEFAULTS, primaryDays: 900 })).status).toBe(400);
    expect((await put(cookie, { ...DEFAULTS, primaryMode: 'forever' })).status).toBe(400);
    const missing: Partial<CertificatePolicySettings> = { ...DEFAULTS };
    delete missing.primaryDays;
    expect((await put(cookie, missing)).status).toBe(400);
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const { cookie } = await admin();
    const res = await request(app).put('/admin/certificate-policy').set('Cookie', cookie).send(DEFAULTS);
    expect(res.status).toBe(403);
  });

  it('ประวัติแก้/ลบไม่ได้ (append-only)', async () => {
    const { cookie } = await admin();
    await put(cookie, { ...DEFAULTS, primaryDays: 200 });
    await expect(pool.query('DELETE FROM certificate_policy_logs')).rejects.toThrow();
  });
});
