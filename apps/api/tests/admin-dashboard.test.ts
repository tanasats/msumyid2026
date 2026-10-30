import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { signer } from '../src/services/signer-client.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';

// หน้า "จัดการระบบ" (GET /admin/dashboard) — แต่ละหมวดตาม permission ที่มีอยู่แล้ว, ตัวเลขนับถูกต้อง, สถานะระบบ

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(signer, 'isHealthy').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function withPermissions(code: `test_${string}`, permissions: string[]) {
  await createTestRole(code, permissions);
  const user = await createUser({ roles: ['user', 'staff', code] });
  return loginAs(user.id);
}

async function superAdminCookie() {
  const user = await createUser({ roles: ['user', 'staff', 'super_admin'] });
  return loginAs(user.id);
}

async function insertCertificate(input: {
  kind?: 'primary' | 'supplementary';
  notBefore: Date;
  notAfter: Date;
  revokedAt?: Date;
  source?: 'issued' | 'imported';
  createdAt?: Date;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO certificates (serial_number, subject_cn, email, not_before, not_after, source, kind,
                               certificate_pem, fingerprint_sha256, revoked_at, revocation_reason, created_at)
     VALUES ($1, 'ทดสอบ', 'test@msu.ac.th', $2, $3, $4, $5, '-----BEGIN CERTIFICATE-----', $6, $7,
             CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE 'superseded' END, $8)
     RETURNING id`,
    [
      `1${randomBytes(15).toString('hex')}`,
      input.notBefore,
      input.notAfter,
      input.source ?? 'issued',
      input.kind ?? 'primary',
      randomBytes(32).toString('hex'),
      input.revokedAt ?? null,
      input.createdAt ?? new Date(),
    ],
  );
  return result.rows[0]!.id;
}

async function insertCrl(nextUpdate: Date) {
  await pool.query(
    `INSERT INTO crls (crl_number, this_update, next_update, revoked_count, crl_der)
     VALUES (1789, now(), $1, 0, '\\x00')`,
    [nextUpdate],
  );
}

describe('GET /admin/dashboard — สิทธิ์', () => {
  it('ยังไม่ login = 401', async () => {
    await request(app).get('/admin/dashboard').expect(401);
  });

  it('ไม่มีสิทธิ์หมวดใดเลย = 403', async () => {
    const user = await createUser({ roles: ['user', 'staff'] });
    const res = await request(app).get('/admin/dashboard').set('Cookie', await loginAs(user.id)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('super_admin เห็นครบทุกหมวด', async () => {
    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.windowDays).toBe(30);
    expect(res.body.pending).toEqual({
      userApprovals: 0,
      primaryRequests: 0,
      supplementaryRequests: 0,
      revocationRequests: 0,
    });
    expect(res.body.users).not.toBeNull();
    expect(res.body.certificates).not.toBeNull();
    expect(res.body.system).not.toBeNull();
  });

  it('ได้เฉพาะหมวดที่มีสิทธิ์ — certificate:revoke เห็นแค่คิวคำขอเพิกถอน', async () => {
    const cookie = await withPermissions('test_revoker', ['certificate:revoke']);
    const res = await request(app).get('/admin/dashboard').set('Cookie', cookie).expect(200);
    expect(res.body.pending).toEqual({ revocationRequests: 0 });
    expect(res.body.users).toBeNull();
    expect(res.body.certificates).toBeNull();
    expect(res.body.system).toBeNull();
  });

  it('หลาย role ได้สิทธิ์รวมกัน: user:read + certificate:approve', async () => {
    await createTestRole('test_reader', ['user:read']);
    await createTestRole('test_approver', ['certificate:approve']);
    const user = await createUser({ roles: ['user', 'staff', 'test_reader', 'test_approver'] });
    const res = await request(app).get('/admin/dashboard').set('Cookie', await loginAs(user.id)).expect(200);
    expect(res.body.pending).toEqual({ primaryRequests: 0, supplementaryRequests: 0 });
    expect(res.body.users).not.toBeNull();
    expect(res.body.certificates).toBeNull();
    // สถานะระบบเป็นของผู้ตั้งค่าระบบ (super_admin) เท่านั้น
    expect(res.body.system).toBeNull();
  });
});

describe('GET /admin/dashboard — ตัวเลข', () => {
  it('นับผู้ใช้และบัญชีรออนุมัติ (ไม่นับบัญชีที่ลบแล้ว / ปิดแล้วที่ยังรออนุมัติ)', async () => {
    const cookie = await superAdminCookie(); // ใช้งานได้ 1
    await createUser(); // ใช้งานได้ 2
    await createUser({ accountType: 'external', approvalStatus: 'pending' });
    await createUser({ accountType: 'unclassified', approvalStatus: 'pending' });
    await createUser({ accountType: 'external', approvalStatus: 'pending', isActive: false });
    await createUser({ isActive: false });
    const old = await createUser();
    await pool.query(`UPDATE users SET created_at = now() - interval '40 days' WHERE id = $1`, [old.id]);
    const deleted = await createUser();
    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [deleted.id]);

    const res = await request(app).get('/admin/dashboard').set('Cookie', cookie).expect(200);
    expect(res.body.pending.userApprovals).toBe(2);
    expect(res.body.users).toEqual({ active: 3, createdSince: 6, unclassified: 1, inactive: 2 });
  });

  it('นับใบรับรอง: ใช้งานได้ตามประเภท ใกล้หมดอายุ ออกใหม่ (ไม่นับใบนำเข้า) และเพิกถอนในช่วง 30 วัน', async () => {
    const now = Date.now();
    const cookie = await superAdminCookie();
    await insertCertificate({ notBefore: new Date(now - 100 * DAY), notAfter: new Date(now + 200 * DAY) });
    await insertCertificate({ notBefore: new Date(now - 300 * DAY), notAfter: new Date(now + 10 * DAY) }); // ใกล้หมดอายุ
    await insertCertificate({ kind: 'supplementary', notBefore: new Date(now - DAY), notAfter: new Date(now + 5 * DAY) });
    await insertCertificate({
      notBefore: new Date(now - 100 * DAY),
      notAfter: new Date(now + 200 * DAY),
      source: 'imported',
      createdAt: new Date(now - DAY),
    });
    await insertCertificate({ notBefore: new Date(now - 400 * DAY), notAfter: new Date(now - DAY) }); // หมดอายุแล้ว
    await insertCertificate({
      notBefore: new Date(now - 100 * DAY),
      notAfter: new Date(now + 200 * DAY),
      revokedAt: new Date(now - 2 * DAY),
    });
    await insertCertificate({
      notBefore: new Date(now - 100 * DAY),
      notAfter: new Date(now + 200 * DAY),
      revokedAt: new Date(now - 60 * DAY),
      createdAt: new Date(now - 100 * DAY),
    });

    const res = await request(app).get('/admin/dashboard').set('Cookie', cookie).expect(200);
    expect(res.body.certificates).toEqual({
      activePrimary: 3,
      activeSupplementary: 1,
      expiringSoon: 2,
      issuedSince: 5,
      revokedSince: 1,
    });
  });
});

describe('GET /admin/dashboard — สถานะระบบ', () => {
  it('ยังไม่เคยออก CRL = error, signer ตอบไม่ได้ = error (หน้ายังตอบ 200)', async () => {
    vi.spyOn(signer, 'isHealthy').mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.body.system.signer).toBe('error');
    expect(res.body.system.crl).toEqual({ level: 'error', crlNumber: null, thisUpdate: null, nextUpdate: null });
  });

  it('CRL เหลืออายุไม่ถึง 72 ชั่วโมง = warning และแสดงเลขเป็นฐาน 16', async () => {
    await insertCrl(new Date(Date.now() + 48 * 60 * 60 * 1000));
    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.body.system.signer).toBe('ok');
    expect(res.body.system.crl.level).toBe('warning');
    expect(res.body.system.crl.crlNumber).toBe('6FD');
  });

  it('CRL เหลืออายุเกิน 72 ชั่วโมง = ok', async () => {
    await insertCrl(new Date(Date.now() + 7 * DAY));
    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.body.system.crl.level).toBe('ok');
  });

  it('งานลงนามค้างเกิน 15 นาที = warning และนับงานที่ล้มเหลวเฉพาะ 24 ชั่วโมงล่าสุด', async () => {
    const owner = await createUser();
    const certificateId = await insertCertificate({ notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY) });
    const file = await pool.query<{ id: string }>(
      `INSERT INTO files (bucket, object_key, purpose, original_name, mime_type, size, status, uploaded_by)
       VALUES ('test', $1, 'signing_source', 'a.pdf', 'application/pdf', 1, 'uploaded', $2) RETURNING id`,
      [`signing-source/${crypto.randomUUID()}`, owner.id],
    );
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO signing_batches (user_id, certificate_id, source, expires_at)
       VALUES ($1, $2, 'single', now() + interval '7 days') RETURNING id`,
      [owner.id, certificateId],
    );
    const job = (status: string, createdAgo: string, errorCode: string | null) =>
      pool.query(
        `INSERT INTO signing_jobs (batch_id, source_file_id, original_name, status, error_code, created_at, updated_at)
         VALUES ($1, $2, 'a.pdf', $3, $4, now() - $5::interval, now() - $5::interval)`,
        [batch.rows[0]!.id, file.rows[0]!.id, status, errorCode, createdAgo],
      );
    await job('pending', '20 minutes', null);
    await job('signing', '1 minute', null);
    await job('failed', '2 hours', 'TSA_UNAVAILABLE');
    await job('failed', '3 days', 'TSA_UNAVAILABLE');

    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.body.system.signingQueue).toMatchObject({ level: 'warning', pending: 1, signing: 1, failedLast24h: 1 });
    expect(res.body.system.signingQueue.oldestOpenAt).not.toBeNull();
  });

  it('คิวลงนามว่าง = ok', async () => {
    const res = await request(app).get('/admin/dashboard').set('Cookie', await superAdminCookie()).expect(200);
    expect(res.body.system.signingQueue).toEqual({
      level: 'ok',
      pending: 0,
      signing: 0,
      oldestOpenAt: null,
      failedLast24h: 0,
    });
  });
});
