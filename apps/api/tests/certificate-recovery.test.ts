import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { SignerError, signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// กู้ key: ดาวน์โหลด .p12 ใหม่จาก key สำรองด้วยรหัสผ่านใหม่
// mock เฉพาะบริการเซ็น (signer ทดสอบการถอด key และสร้าง .p12 กับ OpenSSL จริงแล้ว) ฐานข้อมูลใช้ app_test จริง

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;
const NEW_PASSWORD = 'new-password-1';

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

function mockRebuild() {
  return vi.spyOn(signer, 'rebuildP12').mockResolvedValue(Buffer.from('rebuilt-p12'));
}

async function requester() {
  await createTestRole('test_cert', ['certificate:request']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_cert'] });
  return { ...user, cookie: await loginAs(user.id) };
}

/** ใบรับรอง (+ key สำรอง ถ้า withEscrow) ใส่ตรงในฐานข้อมูล */
async function insertCertificate(
  userId: string,
  input: { withEscrow?: boolean; revoked?: string; expired?: boolean } = {},
) {
  const serialNumber = `1${randomBytes(15).toString('hex')}`;
  const notAfter = new Date(Date.now() + (input.expired ? -DAY : 365 * DAY));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               revoked_at, revocation_reason, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'ทดสอบ', 'owner@msu.ac.th', $3, $4, $5, $6, 'issued', '-----BEGIN CERTIFICATE-----\nPEM', $7)
     RETURNING id`,
    [
      userId,
      serialNumber,
      new Date(notAfter.getTime() - 365 * DAY),
      notAfter,
      input.revoked ? new Date() : null,
      input.revoked ?? null,
      randomBytes(32).toString('hex'),
    ],
  );
  const id = rows[0]!.id;
  const escrow = { kekId: 'test-1', encryptedKey: randomBytes(48), wrappedDataKey: randomBytes(60) };
  if (input.withEscrow ?? true) {
    await pool.query(
      `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id)
       VALUES ($1, $2, $3, $4)`,
      [id, escrow.encryptedKey, escrow.wrappedDataKey, escrow.kekId],
    );
  }
  return { id, serialNumber, escrow };
}

const download = (cookie: string, id: string, body: object = { p12Password: NEW_PASSWORD }) =>
  request(app).post(`/me/certificates/${id}/p12`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

describe('POST /me/certificates/:id/p12 (certificate:request)', () => {
  it('ไม่มี permission → 403 และไม่เรียก signer', async () => {
    const rebuild = mockRebuild();
    const user = await createUser();
    const cert = await insertCertificate(user.id);
    expect((await download(await loginAs(user.id), cert.id)).status).toBe(403);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const user = await requester();
    const cert = await insertCertificate(user.id);
    const res = await request(app)
      .post(`/me/certificates/${cert.id}/p12`)
      .set('Cookie', user.cookie)
      .send({ p12Password: NEW_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('สำเร็จ: ส่งใบ + key สำรองของใบนั้นให้ signer, คืนไฟล์ (no-store) และเขียน audit log recover', async () => {
    const rebuild = mockRebuild();
    const user = await requester();
    const cert = await insertCertificate(user.id);

    const res = await download(user.cookie, cert.id, { p12Password: NEW_PASSWORD, legacyP12: true });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.from(res.body.p12, 'base64').toString()).toBe('rebuilt-p12');
    expect(res.body.fileName).toBe(`owner@msu.ac.th-${cert.serialNumber.slice(0, 8)}.p12`);
    expect(rebuild).toHaveBeenCalledWith({
      serialNumber: cert.serialNumber,
      certificatePem: '-----BEGIN CERTIFICATE-----\nPEM',
      escrow: cert.escrow,
      p12Password: NEW_PASSWORD,
      legacyP12: true,
    });
    const { rows } = await pool.query(
      'SELECT action, actor_id FROM certificate_audit_logs WHERE certificate_id = $1',
      [cert.id],
    );
    expect(rows).toEqual([{ action: 'recover', actor_id: user.id }]);
  });

  it('ใบที่หมดอายุ/ถูกเพิกถอนก็กู้ได้ (ใช้เปิดอีเมลเก่าที่เข้ารหัสไว้)', async () => {
    mockRebuild();
    const user = await requester();
    const expired = await insertCertificate(user.id, { expired: true });
    const revoked = await insertCertificate(user.id, { revoked: 'superseded' });
    expect((await download(user.cookie, expired.id)).status).toBe(200);
    expect((await download(user.cookie, revoked.id)).status).toBe(200);
  });

  it('ใบที่เพิกถอนเพราะ key อาจหลุด (keyCompromise) → 409 KEY_COMPROMISED ไม่เรียก signer และไม่เขียน audit', async () => {
    const rebuild = mockRebuild();
    const user = await requester();
    const cert = await insertCertificate(user.id, { revoked: 'keyCompromise' });
    const res = await download(user.cookie, cert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KEY_COMPROMISED');
    expect(rebuild).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT 1 FROM certificate_audit_logs WHERE certificate_id = $1', [cert.id]);
    expect(rows).toHaveLength(0);
  });

  it('ใบของคนอื่น → 404 และไม่เรียก signer', async () => {
    const rebuild = mockRebuild();
    const user = await requester();
    const other = await createUser();
    const cert = await insertCertificate(other.id);
    const res = await download(user.cookie, cert.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('ใบที่ไม่มี key สำรอง → 409 KEY_NOT_ESCROWED', async () => {
    mockRebuild();
    const user = await requester();
    const cert = await insertCertificate(user.id, { withEscrow: false });
    const res = await download(user.cookie, cert.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('KEY_NOT_ESCROWED');
  });

  it('รหัสผ่านสั้นกว่า 8 ตัว → 400', async () => {
    const rebuild = mockRebuild();
    const user = await requester();
    const cert = await insertCertificate(user.id);
    expect((await download(user.cookie, cert.id, { p12Password: 'short' })).status).toBe(400);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('signer ล่ม → 503 และไม่เขียน audit log', async () => {
    vi.spyOn(signer, 'rebuildP12').mockRejectedValue(new SignerError('ล่ม'));
    const user = await requester();
    const cert = await insertCertificate(user.id);
    const res = await download(user.cookie, cert.id);
    expect(res.status).toBe(503);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM certificate_audit_logs');
    expect(rows[0].n).toBe(0);
  });

  it('รายการใบรับรองบอกว่าใบไหนมี key สำรอง', async () => {
    const user = await requester();
    const withKey = await insertCertificate(user.id);
    const withoutKey = await insertCertificate(user.id, { withEscrow: false });
    const res = await request(app).get('/me/certificates').set('Cookie', user.cookie);
    const byId = Object.fromEntries(
      res.body.certificates.map((c: { id: string; hasKeyEscrow: boolean }) => [c.id, c.hasKeyEscrow]),
    );
    expect(byId).toEqual({ [withKey.id]: true, [withoutKey.id]: false });
  });
});
