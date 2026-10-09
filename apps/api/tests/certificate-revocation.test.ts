import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { crlToPem, isCrlOutdated, issueCrl, issueCrlIfOutdated } from '../src/services/crl-service.js';
import { SignerError, signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// เพิกถอนใบรับรองของตัวเอง + ออก/เผยแพร่ CRL
// mock เฉพาะบริการเซ็น (signer ทดสอบการออก CRL กับ OpenSSL จริงแล้ว) ฐานข้อมูลใช้ app_test จริง

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;
const FAKE_CRL = Buffer.from('fake-crl-der');

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

function mockCrl() {
  return vi.spyOn(signer, 'generateCrl').mockResolvedValue(FAKE_CRL);
}

async function requester() {
  await createTestRole('test_cert', ['certificate:request']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_cert'] });
  return { ...user, cookie: await loginAs(user.id) };
}

/** เพิ่มใบรับรองตรงในฐานข้อมูล */
async function insertCertificate(
  userId: string | null,
  input: { notAfter?: Date; revokedAt?: Date } = {},
): Promise<{ id: string; serialNumber: string }> {
  const serialNumber = `1${randomBytes(15).toString('hex')}`;
  const notAfter = input.notAfter ?? new Date(Date.now() + 365 * DAY);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               revoked_at, revocation_reason, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'ทดสอบ', 'test@msu.ac.th', $3, $4, $5, $6, 'issued', '-----BEGIN CERTIFICATE-----', $7)
     RETURNING id`,
    [
      userId,
      serialNumber,
      new Date(notAfter.getTime() - 365 * DAY),
      notAfter,
      input.revokedAt ?? null,
      input.revokedAt ? 'superseded' : null,
      randomBytes(32).toString('hex'),
    ],
  );
  return { id: rows[0]!.id, serialNumber };
}

const revoke = (cookie: string, id: string, body: object = { reason: 'keyCompromise' }) =>
  request(app).post(`/me/certificates/${id}/revoke`).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

describe('POST /me/certificates/:id/revoke (certificate:request)', () => {
  it('ไม่มี permission → 403', async () => {
    mockCrl();
    const user = await createUser();
    const cert = await insertCertificate(user.id);
    const res = await revoke(await loginAs(user.id), cert.id);
    expect(res.status).toBe(403);
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const user = await requester();
    const cert = await insertCertificate(user.id);
    const res = await request(app)
      .post(`/me/certificates/${cert.id}/revoke`)
      .set('Cookie', user.cookie)
      .send({ reason: 'keyCompromise' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('เพิกถอนสำเร็จ: บันทึกเวลา/เหตุผล/ผู้เพิกถอน + audit log และออก CRL ที่มีใบนี้', async () => {
    const generate = mockCrl();
    const user = await requester();
    const cert = await insertCertificate(user.id);

    const res = await revoke(user.cookie, cert.id, { reason: 'keyCompromise' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crlUpdated: true });
    const { rows } = await pool.query(
      `SELECT c.revoked_at IS NOT NULL AS revoked, c.revocation_reason, c.revoked_by, a.action, a.actor_id, a.reason
       FROM certificates c JOIN certificate_audit_logs a ON a.certificate_id = c.id
       WHERE c.id = $1`,
      [cert.id],
    );
    expect(rows).toEqual([
      {
        revoked: true,
        revocation_reason: 'keyCompromise',
        revoked_by: user.id,
        action: 'revoke',
        actor_id: user.id,
        reason: 'keyCompromise',
      },
    ]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0].revoked).toEqual([
      expect.objectContaining({ serialNumber: cert.serialNumber, reason: 'keyCompromise' }),
    ]);
  });

  it('ใบของคนอื่น → 404 (ไม่บอกว่ามีใบนั้น) และไม่ถูกเพิกถอน', async () => {
    mockCrl();
    const user = await requester();
    const other = await createUser();
    const cert = await insertCertificate(other.id);

    const res = await revoke(user.cookie, cert.id);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
    const { rows } = await pool.query('SELECT revoked_at FROM certificates WHERE id = $1', [cert.id]);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('ใบที่ไม่มีอยู่ → 404, id ผิดรูปแบบ → 400', async () => {
    const user = await requester();
    expect((await revoke(user.cookie, crypto.randomUUID())).status).toBe(404);
    expect((await revoke(user.cookie, 'not-a-uuid')).status).toBe(400);
  });

  it('เพิกถอนซ้ำ → 409, ใบหมดอายุ → 409', async () => {
    mockCrl();
    const user = await requester();
    const revoked = await insertCertificate(user.id, { revokedAt: new Date() });
    const expired = await insertCertificate(user.id, { notAfter: new Date(Date.now() - DAY) });

    const again = await revoke(user.cookie, revoked.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CERTIFICATE_ALREADY_REVOKED');
    const old = await revoke(user.cookie, expired.id);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('CERTIFICATE_EXPIRED');
  });

  it.each(['unspecified', 'CACompromise', 'certificateHold', ''])('เหตุผล "%s" ผู้ใช้เลือกเองไม่ได้ → 400', async (reason) => {
    const user = await requester();
    const cert = await insertCertificate(user.id);
    expect((await revoke(user.cookie, cert.id, { reason })).status).toBe(400);
  });

  it('signer ล่มตอนออก CRL → การเพิกถอนยังสำเร็จ และ job เห็นว่าต้องออก CRL ใหม่', async () => {
    mockCrl();
    await issueCrl(); // มี CRL ฉบับล่าสุดอยู่แล้ว (ยังไม่มีใบเพิกถอน)
    vi.spyOn(signer, 'generateCrl').mockRejectedValue(new SignerError('ล่ม'));
    const user = await requester();
    const cert = await insertCertificate(user.id);

    const res = await revoke(user.cookie, cert.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ crlUpdated: false });
    const { rows } = await pool.query('SELECT revoked_at IS NOT NULL AS revoked FROM certificates WHERE id = $1', [cert.id]);
    expect(rows[0].revoked).toBe(true);
    expect(await isCrlOutdated()).toBe(true);
  });

  it('เพิกถอนแล้วจำนวนใบที่ใช้งานอยู่ลดลง จึงขอใบใหม่ได้อีก', async () => {
    mockCrl();
    vi.spyOn(signer, 'issueCertificate').mockImplementation(async () => ({
      certificatePem: '-----BEGIN CERTIFICATE-----\n',
      serialNumber: `1${randomBytes(15).toString('hex')}`,
      fingerprintSha256: randomBytes(32).toString('hex'),
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 365 * DAY),
      p12: Buffer.from('p12'),
      escrow: { kekId: 'test-1', encryptedKey: randomBytes(40), wrappedDataKey: randomBytes(60) },
    }));
    const user = await requester();
    const first = await insertCertificate(user.id);
    await insertCertificate(user.id);
    const ask = () =>
      request(app).post('/me/certificates').set('Cookie', user.cookie).set('Origin', ORIGIN).send({ p12Password: 'password1' });

    expect((await ask()).status).toBe(409);
    await revoke(user.cookie, first.id, { reason: 'superseded' });
    expect((await ask()).status).toBe(201);
  });
});

describe('ออก CRL', () => {
  it('รวมใบที่เพิกถอนทั้งหมด (รวมใบที่ยังไม่มีเจ้าของ) ไม่รวมใบที่ยังใช้งานอยู่', async () => {
    const generate = mockCrl();
    const user = await createUser();
    const revokedA = await insertCertificate(user.id, { revokedAt: new Date(Date.now() - DAY) });
    const revokedImported = await insertCertificate(null, { revokedAt: new Date(Date.now() - 2 * DAY) });
    await insertCertificate(user.id);

    const { revokedCount } = await issueCrl();

    expect(revokedCount).toBe(2);
    const input = generate.mock.calls[0]![0];
    expect(input.revoked.map((r) => r.serialNumber).sort()).toEqual(
      [revokedA.serialNumber, revokedImported.serialNumber].sort(),
    );
    // อายุ CRL ตาม CRL_VALIDITY_DAYS (ค่าเริ่มต้น 7 วัน) และเวลาละเอียดถึงวินาที
    expect(input.nextUpdate.getTime() - input.thisUpdate.getTime()).toBe(7 * DAY);
    expect(input.thisUpdate.getMilliseconds()).toBe(0);
  });

  it('เลข CRL = เวลา Unix (วินาที) และเพิ่มขึ้นเสมอแม้ออกหลายฉบับในวินาทีเดียวกัน', async () => {
    const generate = mockCrl();
    const before = BigInt(Math.floor(Date.now() / 1000));
    const results = await Promise.all([issueCrl(), issueCrl(), issueCrl()]);

    const numbers = results.map((r) => r.crlNumber).sort((a, b) => (a < b ? -1 : 1));
    expect(numbers[0]! >= before).toBe(true);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers[1]! > numbers[0]! && numbers[2]! > numbers[1]!).toBe(true);
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('ออกใหม่เมื่อจำเป็นเท่านั้น: ยังไม่เคยออก → ออก, ไม่มีอะไรเปลี่ยน → ไม่ออก, มีการเพิกถอนใหม่ → ออก', async () => {
    const generate = mockCrl();
    expect(await issueCrlIfOutdated()).toBe(true);
    expect(await issueCrlIfOutdated()).toBe(false);

    const user = await createUser();
    await insertCertificate(user.id, { revokedAt: new Date() });
    expect(await issueCrlIfOutdated()).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('ฉบับล่าสุดเก่ากว่า CRL_REISSUE_HOURS → ถือว่าต้องออกใหม่', async () => {
    mockCrl();
    await issueCrl();
    expect(await isCrlOutdated()).toBe(false);
    expect(await isCrlOutdated(new Date(Date.now() + 25 * 60 * 60 * 1000))).toBe(true);
  });
});

describe('GET /crl/msu-ca.crl (public)', () => {
  it('ยังไม่เคยออก CRL → 404', async () => {
    const res = await request(app).get('/crl/msu-ca.crl');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CRL_NOT_AVAILABLE');
  });

  it('ไม่ต้อง login ได้ฉบับล่าสุดแบบ PEM (เหมือน openssl ca -gencrl เดิม) และไม่ให้ cache ค้าง', async () => {
    vi.spyOn(signer, 'generateCrl').mockResolvedValueOnce(Buffer.from('first')).mockResolvedValueOnce(FAKE_CRL);
    await issueCrl();
    await issueCrl();

    const res = await request(app).get('/crl/msu-ca.crl');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-pem-file');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['last-modified']).toBeDefined();
    expect(res.text).toBe(crlToPem(FAKE_CRL));
  });

  it('crlToPem: base64 บรรทัดละ 64 ตัว ครอบด้วย BEGIN/END X509 CRL', () => {
    const pem = crlToPem(Buffer.alloc(100, 1));
    const lines = pem.trimEnd().split('\n');
    expect(lines[0]).toBe('-----BEGIN X509 CRL-----');
    expect(lines.at(-1)).toBe('-----END X509 CRL-----');
    expect(lines[1]).toHaveLength(64);
    expect(Buffer.from(lines.slice(1, -1).join(''), 'base64')).toEqual(Buffer.alloc(100, 1));
  });
});
