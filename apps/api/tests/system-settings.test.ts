import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { isCrlOutdated, issueCrl } from '../src/services/crl-service.js';
import { signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ค่าตั้งของระบบ (/admin/system-settings) — super_admin เท่านั้น และทุกจุดที่ใช้อ่านค่าจากฐานข้อมูล (มีผลทันที)
// ส่วนโดเมนที่ไม่ต้องรออนุมัติตอน login ทดสอบใน google-login (ใช้ค่าเริ่มต้น msu.ac.th จาก migration)

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  allowedEmailDomains: ['msu.ac.th'],
  sessionTtlDays: 7,
  crlValidityDays: 7,
  crlReissueHours: 24,
};

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

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const put = (cookie: string, body: object) =>
  request(app).put('/admin/system-settings').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

describe('สิทธิ์ (super_admin เท่านั้น)', () => {
  it('ยังไม่ login → 401 / ไม่ใช่ super_admin (แม้มีทุก permission) → 403 / capabilities บอก web', async () => {
    expect((await request(app).get('/admin/system-settings')).status).toBe(401);
    const codes = (await pool.query<{ code: string }>('SELECT code FROM permissions')).rows.map((r) => r.code);
    await createTestRole('test_everything', codes);
    const user = await createUser({ roles: ['user', 'staff', 'admin', 'test_everything'] });
    const cookie = await loginAs(user.id);
    expect((await request(app).get('/admin/system-settings').set('Cookie', cookie)).status).toBe(403);
    expect((await put(cookie, { ...DEFAULTS, sessionTtlDays: 1, reason: 'x' })).status).toBe(403);
    expect((await request(app).get('/auth/me').set('Cookie', cookie)).body.user.capabilities.manageSettings).toBe(false);

    const admin = await superAdmin();
    expect((await request(app).get('/auth/me').set('Cookie', admin.cookie)).body.user.capabilities.manageSettings).toBe(true);
  });
});

describe('อ่าน / แก้ค่าตั้ง', () => {
  it('ค่าเริ่มต้นจาก migration = ค่าเดิมใน env ตัวอย่าง', async () => {
    const admin = await superAdmin();
    const res = await request(app).get('/admin/system-settings').set('Cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ ...DEFAULTS, updatedBy: null });
    expect(res.body.logs).toEqual([]);
  });

  it('แก้ค่า → โดเมนเป็นตัวพิมพ์เล็กไม่ซ้ำ, บันทึกผู้แก้ และประวัติค่าก่อน/หลังพร้อมเหตุผล', async () => {
    const admin = await superAdmin();
    const res = await put(admin.cookie, {
      allowedEmailDomains: ['MSU.ac.th', 'msu.ac.th', ' rbru.ac.th '],
      sessionTtlDays: 3,
      crlValidityDays: 10,
      crlReissueHours: 12,
      reason: 'นโยบายความปลอดภัยใหม่',
    });
    expect(res.status).toBe(200);
    const after = { allowedEmailDomains: ['msu.ac.th', 'rbru.ac.th'], sessionTtlDays: 3, crlValidityDays: 10, crlReissueHours: 12 };
    expect(res.body.settings).toMatchObject({ ...after, updatedBy: { id: admin.id } });
    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0]).toMatchObject({ actor: { id: admin.id }, before: DEFAULTS, after, reason: 'นโยบายความปลอดภัยใหม่' });
  });

  it('ค่าผิด → 400 / รอบออก CRL ไม่น้อยกว่าอายุ CRL → 422 / ค่าเดิม → 400 NO_CHANGES และไม่บันทึก', async () => {
    const admin = await superAdmin();
    for (const body of [
      { ...DEFAULTS, allowedEmailDomains: [] },
      { ...DEFAULTS, allowedEmailDomains: ['not a domain'] },
      { ...DEFAULTS, sessionTtlDays: 31 },
      { ...DEFAULTS, crlReissueHours: 0 },
      DEFAULTS, // ไม่มีเหตุผล
    ]) {
      expect((await put(admin.cookie, { reason: 'x', ...body, ...(body === DEFAULTS ? { reason: '' } : {}) })).status).toBe(400);
    }
    const invalid = await put(admin.cookie, { ...DEFAULTS, crlValidityDays: 1, crlReissueHours: 24, reason: 'x' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('SETTINGS_INVALID');
    const same = await put(admin.cookie, { ...DEFAULTS, reason: 'x' });
    expect(same.body.error.code).toBe('NO_CHANGES');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM system_setting_logs');
    expect(rows[0].n).toBe(0);
  });

  it('ประวัติแก้/ลบไม่ได้ (append-only)', async () => {
    const admin = await superAdmin();
    await put(admin.cookie, { ...DEFAULTS, sessionTtlDays: 5, reason: 'x' });
    await expect(pool.query('DELETE FROM system_setting_logs')).rejects.toThrow();
  });
});

describe('มีผลทันทีโดยไม่ต้อง restart', () => {
  it('อายุ session ที่สร้างใหม่ตาม session_ttl_days (session เดิมไม่เปลี่ยน)', async () => {
    const user = await createUser();
    await loginAs(user.id);
    await pool.query('UPDATE system_settings SET session_ttl_days = 2');
    await loginAs(user.id);
    const { rows } = await pool.query<{ days: number }>(
      `SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days
       FROM sessions WHERE user_id = $1 ORDER BY created_at`,
      [user.id],
    );
    expect(rows.map((r) => r.days)).toEqual([7, 2]);
  });

  it('CRL: อายุ (next update) ตาม crl_validity_days และรอบออกใหม่ตาม crl_reissue_hours', async () => {
    vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    await pool.query('UPDATE system_settings SET crl_validity_days = 3, crl_reissue_hours = 2');
    await issueCrl();
    const { rows } = await pool.query<{ thisUpdate: Date; nextUpdate: Date }>(
      'SELECT this_update AS "thisUpdate", next_update AS "nextUpdate" FROM crls ORDER BY crl_number DESC LIMIT 1',
    );
    expect(rows[0]!.nextUpdate.getTime() - rows[0]!.thisUpdate.getTime()).toBe(3 * DAY);
    expect(await isCrlOutdated(new Date(rows[0]!.thisUpdate.getTime() + 60 * 60 * 1000))).toBe(false);
    expect(await isCrlOutdated(new Date(rows[0]!.thisUpdate.getTime() + 2 * 60 * 60 * 1000))).toBe(true);
  });
});
