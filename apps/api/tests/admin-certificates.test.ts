import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { expireAccounts } from '../src/services/account-expiry-service.js';
import { signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// ผู้ดูแล: ค้นหา/ดู/เพิกถอนใบรับรองของผู้อื่น และเพิกถอนอัตโนมัติเมื่อปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ
// mock เฉพาะบริการเซ็น (ออก CRL) ฐานข้อมูลใช้ app_test จริง

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;

let generateCrl: MockInstance<typeof signer.generateCrl>;

beforeEach(async () => {
  await resetDatabase();
  generateCrl = vi.spyOn(signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

/** ผู้ดูแลที่ได้ permission ผ่าน role ทดสอบ */
async function admin(permissions: string[], extraRoles: string[] = []) {
  const code = `test_${permissions.join('_').replace(/[^a-z]/g, '')}` as const;
  await createTestRole(code as `test_${string}`, permissions).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', code, ...extraRoles] });
  return { ...user, cookie: await loginAs(user.id) };
}

async function superAdmin() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return { ...user, cookie: await loginAs(user.id) };
}

async function insertCertificate(
  userId: string | null,
  input: { cn?: string; email?: string; serial?: string; expired?: boolean; revoked?: boolean; escrow?: boolean } = {},
) {
  const serialNumber = input.serial ?? `1${randomBytes(15).toString('hex')}`;
  const notAfter = new Date(Date.now() + (input.expired ? -DAY : 365 * DAY));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               revoked_at, revocation_reason, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'issued', '-----BEGIN CERTIFICATE-----\nPEM', $9)
     RETURNING id`,
    [
      userId,
      serialNumber,
      input.cn ?? 'ผู้ถือใบ ทดสอบ',
      input.email ?? 'holder@msu.ac.th',
      new Date(notAfter.getTime() - 365 * DAY),
      notAfter,
      input.revoked ? new Date() : null,
      input.revoked ? 'superseded' : null,
      randomBytes(32).toString('hex'),
    ],
  );
  const id = rows[0]!.id;
  if (input.escrow) {
    await pool.query(
      `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id) VALUES ($1, $2, $3, 'test-1')`,
      [id, randomBytes(40), randomBytes(60)],
    );
  }
  return { id, serialNumber };
}

async function certificateRow(id: string) {
  const { rows } = await pool.query(
    `SELECT revocation_reason, revoked_by, subject_cn, email, certificate_pem,
            EXISTS (SELECT 1 FROM certificate_key_escrows e WHERE e.certificate_id = c.id) AS escrowed,
            (SELECT array_agg(a.reason) FROM certificate_audit_logs a WHERE a.certificate_id = c.id AND a.action = 'revoke') AS notes
     FROM certificates c WHERE id = $1`,
    [id],
  );
  return rows[0];
}

const adminRevoke = (cookie: string, id: string, body: object = { reason: 'keyCompromise', note: 'ผู้ใช้แจ้งว่าทำเครื่องหาย' }) =>
  request(app).post(`/admin/certificates/${id}/revoke`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

describe('GET /admin/certificates (certificate:read)', () => {
  it('ไม่มี permission → 403', async () => {
    const user = await createUser();
    expect((await request(app).get('/admin/certificates').set('Cookie', await loginAs(user.id))).status).toBe(403);
  });

  it('ค้นหาด้วยชื่อ / อีเมลบางส่วน / serial (มี : และตัวพิมพ์ใหญ่ก็ได้) และแสดงเจ้าของ', async () => {
    const reader = await admin(['certificate:read']);
    const owner = await createUser({ name: 'สมศรี มีสุข' });
    const a = await insertCertificate(owner.id, { cn: 'สมศรี มีสุข', email: 'somsri.m@msu.ac.th', serial: 'abcdef0123' });
    const b = await insertCertificate(null, { cn: 'Guest', email: 'guest@gmail.com' });

    const search = async (q: string) =>
      (await request(app).get('/admin/certificates').query({ q }).set('Cookie', reader.cookie)).body.certificates.map(
        (c: { id: string }) => c.id,
      );
    expect(await search('สมศรี')).toEqual([a.id]);
    expect(await search('GMAIL')).toEqual([b.id]);
    expect(await search('AB:CD:EF:01:23')).toEqual([a.id]);
    // % และ _ เป็นตัวอักษรธรรมดา ไม่ใช่ wildcard ของ LIKE
    expect(await search('%')).toEqual([]);
    expect(await search('_')).toEqual([]);

    const res = await request(app).get('/admin/certificates').set('Cookie', reader.cookie);
    const byId = Object.fromEntries(res.body.certificates.map((c: { id: string; owner: unknown }) => [c.id, c.owner]));
    expect(byId[a.id]).toEqual({ id: owner.id, displayName: 'สมศรี มีสุข' });
    expect(byId[b.id]).toBeNull();
  });

  it('กรองสถานะ และแบ่งหน้าด้วย cursor (หน้าละ 20)', async () => {
    const reader = await admin(['certificate:read']);
    const user = await createUser();
    const revoked = await insertCertificate(user.id, { revoked: true });
    const expired = await insertCertificate(user.id, { expired: true });
    for (let i = 0; i < 21; i++) await insertCertificate(user.id);

    const get = (query: object) => request(app).get('/admin/certificates').query(query).set('Cookie', reader.cookie);
    expect((await get({ status: 'revoked' })).body.certificates.map((c: { id: string }) => c.id)).toEqual([revoked.id]);
    expect((await get({ status: 'expired' })).body.certificates.map((c: { id: string }) => c.id)).toEqual([expired.id]);

    const first = await get({ status: 'active' });
    expect(first.body.certificates).toHaveLength(20);
    const second = await get({ status: 'active', cursor: first.body.nextCursor });
    expect(second.body.certificates).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('GET /admin/users/:id/certificates: ใบของผู้ใช้คนนั้นเท่านั้น', async () => {
    const reader = await admin(['certificate:read']);
    const user = await createUser();
    const mine = await insertCertificate(user.id);
    await insertCertificate((await createUser()).id);
    const res = await request(app).get(`/admin/users/${user.id}/certificates`).set('Cookie', reader.cookie);
    expect(res.status).toBe(200);
    expect(res.body.certificates.map((c: { id: string }) => c.id)).toEqual([mine.id]);
  });
});

describe('POST /admin/certificates/:id/revoke (certificate:revoke)', () => {
  it('มีแค่ certificate:read → 403', async () => {
    const reader = await admin(['certificate:read']);
    const cert = await insertCertificate((await createUser()).id);
    expect((await adminRevoke(reader.cookie, cert.id)).status).toBe(403);
  });

  it('สำเร็จ: บันทึกผู้เพิกถอน + บันทึกประกอบใน audit log แล้วออก CRL', async () => {
    const revoker = await admin(['certificate:revoke']);
    const cert = await insertCertificate((await createUser()).id);

    const res = await adminRevoke(revoker.cookie, cert.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crlUpdated: true });
    expect(await certificateRow(cert.id)).toMatchObject({
      revocation_reason: 'keyCompromise',
      revoked_by: revoker.id,
      notes: ['ผู้ใช้แจ้งว่าทำเครื่องหาย'],
    });
    expect(generateCrl).toHaveBeenCalledTimes(1);
  });

  it('ใบที่ยังไม่มีเจ้าของ (นำเข้า) เพิกถอนได้', async () => {
    const revoker = await admin(['certificate:revoke']);
    const cert = await insertCertificate(null);
    expect((await adminRevoke(revoker.cookie, cert.id)).status).toBe(200);
  });

  it('ใบของตัวเอง → 403 CANNOT_MANAGE_SELF (ให้ใช้หน้าของฉัน)', async () => {
    const revoker = await admin(['certificate:revoke']);
    const cert = await insertCertificate(revoker.id);
    const res = await adminRevoke(revoker.cookie, cert.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CANNOT_MANAGE_SELF');
  });

  it('ใบของผู้ดูแลสิทธิ์สูง: ผู้มี permission ทั่วไป → 403, super_admin → ได้', async () => {
    const revoker = await admin(['certificate:revoke']);
    const privileged = await createUser({ roles: ['user', 'staff', 'admin'] });
    const cert = await insertCertificate(privileged.id);
    const denied = await adminRevoke(revoker.cookie, cert.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PRIVILEGED_TARGET');
    expect((await adminRevoke((await superAdmin()).cookie, cert.id)).status).toBe(200);
  });

  it('เพิกถอนซ้ำ / หมดอายุ → 409, ไม่พบ → 404', async () => {
    const revoker = await admin(['certificate:revoke']);
    const user = await createUser();
    expect((await adminRevoke(revoker.cookie, (await insertCertificate(user.id, { revoked: true })).id)).status).toBe(409);
    expect((await adminRevoke(revoker.cookie, (await insertCertificate(user.id, { expired: true })).id)).status).toBe(409);
    expect((await adminRevoke(revoker.cookie, crypto.randomUUID())).status).toBe(404);
  });

  it.each([
    ['ไม่มีบันทึกประกอบ', { reason: 'keyCompromise', note: ' ' }],
    ['เหตุผล CACompromise (สงวนไว้)', { reason: 'CACompromise', note: 'x' }],
  ])('%s → 400', async (_label, body) => {
    const revoker = await admin(['certificate:revoke']);
    const cert = await insertCertificate((await createUser()).id);
    expect((await adminRevoke(revoker.cookie, cert.id, body)).status).toBe(400);
  });
});

describe('เพิกถอนอัตโนมัติเมื่อปิด/ลบ/หมดอายุ', () => {
  it('ปิดบัญชี → เพิกถอนใบที่ใช้งานอยู่ (cessationOfOperation) ไม่แตะใบที่หมดอายุ แล้วออก CRL — เปิดบัญชีคืนไม่ย้อนการเพิกถอน', async () => {
    const actor = await superAdmin();
    const user = await createUser();
    const active = await insertCertificate(user.id);
    const expired = await insertCertificate(user.id, { expired: true });

    const res = await request(app)
      .post(`/admin/users/${user.id}/deactivate`)
      .set('Cookie', actor.cookie)
      .set('Origin', ORIGIN)
      .send({ reason: 'ลาออก' });
    expect(res.status).toBe(204);

    expect(await certificateRow(active.id)).toMatchObject({
      revocation_reason: 'cessationOfOperation',
      revoked_by: actor.id,
      notes: ['ปิดบัญชี: ลาออก'],
    });
    expect((await certificateRow(expired.id)).revocation_reason).toBeNull();
    expect(generateCrl).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      `SELECT changes->'revokedCertificates' AS n FROM user_audit_logs WHERE target_user_id = $1 AND action = 'deactivate'`,
      [user.id],
    );
    expect(rows[0].n).toBe(1);

    await request(app)
      .post(`/admin/users/${user.id}/activate`)
      .set('Cookie', actor.cookie)
      .set('Origin', ORIGIN)
      .send({ reason: 'กลับมาทำงาน' });
    expect((await certificateRow(active.id)).revocation_reason).toBe('cessationOfOperation');
  });

  it('ปิดบัญชีที่ไม่มีใบรับรอง → ไม่ออก CRL', async () => {
    const actor = await superAdmin();
    const user = await createUser();
    await request(app)
      .post(`/admin/users/${user.id}/deactivate`)
      .set('Cookie', actor.cookie)
      .set('Origin', ORIGIN)
      .send({ reason: 'ทดสอบ' });
    expect(generateCrl).not.toHaveBeenCalled();
  });

  it('ลบบัญชี → เพิกถอน แล้วลบชื่อ/อีเมล/ตัวใบ/key สำรอง แต่คง serial และการเพิกถอนไว้ให้ CRL', async () => {
    const actor = await superAdmin();
    const user = await createUser({ email: 'leaving@msu.ac.th' });
    const cert = await insertCertificate(user.id, { escrow: true });

    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', actor.cookie)
      .set('Origin', ORIGIN)
      .send({ confirmEmail: 'leaving@msu.ac.th', reason: 'ขอลบข้อมูล' });
    expect(res.status).toBe(204);

    expect(await certificateRow(cert.id)).toMatchObject({
      revocation_reason: 'cessationOfOperation',
      subject_cn: '',
      email: '',
      certificate_pem: '',
      escrowed: false,
    });
    expect(generateCrl.mock.calls[0]![0].revoked.map((r) => r.serialNumber)).toEqual([cert.serialNumber]);
  });

  it('บัญชีหมดอายุ (job) → เพิกถอนใบโดยระบบ (revoked_by = NULL) แล้วออก CRL', async () => {
    const user = await createUser({ accountType: 'service', accountExpiresAt: new Date(Date.now() - 1000) });
    const cert = await insertCertificate(user.id);

    expect(await expireAccounts()).toBe(1);

    expect(await certificateRow(cert.id)).toMatchObject({
      revocation_reason: 'cessationOfOperation',
      revoked_by: null,
      notes: ['บัญชีหมดอายุ ระบบปิดอัตโนมัติ'],
    });
    expect(generateCrl).toHaveBeenCalledTimes(1);
  });
});
