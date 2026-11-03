import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { queueApproverDigest, queueCertificateExpiryNotices } from '../src/services/notification-service.js';
import { createTestRole, createUser, queuedEmails, resetDatabase } from './helpers/db.js';

// งานแจ้งเตือนตามรอบ (docs/design/email.md ระยะที่ 2) — ฐานข้อมูลจริง ตรวจที่คิว email_outbox

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  await pool.query('TRUNCATE notification_runs');
});

afterAll(async () => {
  await resetDatabase();
  await pool.query('TRUNCATE notification_runs');
  await pool.end();
});

async function insertCertificate(input: {
  userId: string;
  kind?: 'primary' | 'supplementary';
  notBefore: Date;
  notAfter: Date;
  revokedAt?: Date;
}): Promise<{ id: string; serialNumber: string }> {
  const serialNumber = `1${randomBytes(15).toString('hex')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after, source, kind,
                               certificate_pem, fingerprint_sha256, revoked_at, revocation_reason)
     VALUES ($1, $2, 'ทดสอบ', 'test@msu.ac.th', $3, $4, 'issued', $5, '-----BEGIN CERTIFICATE-----', $6, $7,
             CASE WHEN $7::timestamptz IS NULL THEN NULL ELSE 'superseded' END)
     RETURNING id`,
    [
      input.userId,
      serialNumber,
      input.notBefore,
      input.notAfter,
      input.kind ?? 'primary',
      randomBytes(32).toString('hex'),
      input.revokedAt ?? null,
    ],
  );
  return { id: result.rows[0]!.id, serialNumber };
}

describe('เตือนใบใกล้หมดอายุ', () => {
  const now = new Date('2026-11-03T03:00:00Z');
  const at = (days: number) => new Date(now.getTime() + days * DAY);

  it('เหลือไม่ถึง 30 วัน → รอบ 30 วันครั้งเดียว / เข้าช่วง 7 วัน → รอบ 7 วัน', async () => {
    const user = await createUser();
    const cert = await insertCertificate({ userId: user.id, notBefore: at(-345), notAfter: at(20) });

    expect(await queueCertificateExpiryNotices(now)).toBe(1);
    expect(await queueCertificateExpiryNotices(now)).toBe(0);
    expect(await queuedEmails(user.id)).toEqual([
      {
        template: 'certificate_expiring',
        params: { kind: 'primary', serialNumber: cert.serialNumber, notAfter: at(20).toISOString(), daysBefore: 30 },
      },
    ]);
    const { rows } = await pool.query(`SELECT priority FROM email_outbox WHERE recipient_user_id = $1`, [user.id]);
    expect(rows).toEqual([{ priority: 1 }]);

    // 15 วันต่อมา เหลือ 5 วัน
    expect(await queueCertificateExpiryNotices(at(15))).toBe(1);
    expect((await queuedEmails(user.id)).map((e) => e.params.daysBefore)).toEqual([30, 7]);
  });

  it('เหลือไม่ถึง 7 วันตั้งแต่แรก → ได้เฉพาะรอบ 7 วัน (ไม่ส่ง "อีก 30 วัน")', async () => {
    const user = await createUser();
    await insertCertificate({ userId: user.id, notBefore: at(-360), notAfter: at(5) });
    expect(await queueCertificateExpiryNotices(now)).toBe(1);
    expect((await queuedEmails(user.id)).map((e) => e.params.daysBefore)).toEqual([7]);
  });

  it('ไม่เตือน: ใบอายุสั้นกว่ารอบ, เพิกถอนแล้ว, หมดอายุแล้ว, ต่ออายุแล้ว, บัญชีถูกปิด', async () => {
    const short = await createUser();
    // ใบเสริม 20 วัน: ไม่ได้รอบ 30 วัน (ได้รอบ 7 วันภายหลัง)
    await insertCertificate({ userId: short.id, kind: 'supplementary', notBefore: at(-1), notAfter: at(19) });

    const revoked = await createUser();
    await insertCertificate({ userId: revoked.id, notBefore: at(-300), notAfter: at(10), revokedAt: at(-1) });

    const expired = await createUser();
    await insertCertificate({ userId: expired.id, notBefore: at(-365), notAfter: at(-1) });

    const renewed = await createUser();
    await insertCertificate({ userId: renewed.id, notBefore: at(-340), notAfter: at(25) });
    await insertCertificate({ userId: renewed.id, notBefore: at(-1), notAfter: at(364) });

    const closed = await createUser({ isActive: false });
    await insertCertificate({ userId: closed.id, notBefore: at(-340), notAfter: at(25) });

    expect(await queueCertificateExpiryNotices(now)).toBe(0);
    expect(await queueCertificateExpiryNotices(at(13))).toBe(1);
    expect((await queuedEmails(short.id)).map((e) => e.params.daysBefore)).toEqual([7]);
  });
});

describe('สรุปงานให้ผู้อนุมัติ', () => {
  // 2026-11-02 = วันจันทร์
  const mondayNine = new Date('2026-11-02T02:00:00Z'); // 09:00 เวลาไทย
  const mondaySeven = new Date('2026-11-02T00:00:00Z'); // 07:00
  const saturdayNine = new Date('2026-11-07T02:00:00Z');

  async function pendingWork() {
    const requester = await createUser();
    await createUser({ accountType: 'external', approvalStatus: 'pending' });
    await pool.query(`INSERT INTO primary_certificate_requests (user_id) VALUES ($1)`, [requester.id]);
    const cert = await insertCertificate({ userId: requester.id, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + 300 * DAY) });
    await pool.query(
      `INSERT INTO certificate_revocation_requests (certificate_id, user_id, reason) VALUES ($1, $2, 'superseded')`,
      [cert.id, requester.id],
    );
  }

  it('ก่อน 08:00 / วันเสาร์-อาทิตย์ → ยังไม่ทำ', async () => {
    await pendingWork();
    await createUser({ roles: ['user', 'staff', 'super_admin'] });
    expect(await queueApproverDigest(mondaySeven)).toBeNull();
    expect(await queueApproverDigest(saturdayNine)).toBeNull();
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM email_outbox`);
    expect(rows[0].n).toBe(0);
  });

  it('แต่ละคนเห็นเฉพาะคิวที่มีสิทธิ์ (super_admin ครบ, หลาย role รวมสิทธิ์) และวันละครั้ง', async () => {
    await pendingWork();
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    await createTestRole('test_revoker', ['certificate:revoke']);
    const revoker = await createUser({ roles: ['user', 'staff', 'test_revoker'] });
    await createTestRole('test_user_approver', ['user:approve']);
    await createTestRole('test_cert_approver', ['certificate:approve']);
    const both = await createUser({ roles: ['user', 'staff', 'test_user_approver', 'test_cert_approver'] });
    const nobody = await createUser();
    await createTestRole('test_closed', ['certificate:approve']);
    const closed = await createUser({ roles: ['user', 'staff', 'test_closed'], isActive: false });

    expect(await queueApproverDigest(mondayNine)).toBe(3);
    expect(await queuedEmails(admin.id)).toEqual([
      {
        template: 'approver_digest',
        params: { userApprovals: 1, primaryRequests: 1, revocationRequests: 1 },
      },
    ]);
    expect((await queuedEmails(revoker.id))[0]!.params).toEqual({ revocationRequests: 1 });
    expect((await queuedEmails(both.id))[0]!.params).toEqual({ userApprovals: 1, primaryRequests: 1 });
    expect(await queuedEmails(nobody.id)).toEqual([]);
    expect(await queuedEmails(closed.id)).toEqual([]);

    // รอบถัดไปของวันเดียวกัน → ไม่ส่งซ้ำ
    expect(await queueApproverDigest(new Date(mondayNine.getTime() + 60 * 60 * 1000))).toBeNull();
    const { rows } = await pool.query(`SELECT to_char(run_on, 'YYYY-MM-DD') AS run_on, queued FROM notification_runs`);
    expect(rows).toEqual([{ run_on: '2026-11-02', queued: 3 }]);
  });

  it('ไม่มีงานค้าง → บันทึกว่าทำแล้วแต่ไม่ส่ง / ผู้มีสิทธิ์เฉพาะคิวที่ว่าง → ไม่ส่ง', async () => {
    await createUser({ roles: ['user', 'staff', 'super_admin'] });
    expect(await queueApproverDigest(mondayNine)).toBe(0);

    await pool.query('TRUNCATE notification_runs');
    await createUser({ accountType: 'external', approvalStatus: 'pending' });
    await createTestRole('test_revoker', ['certificate:revoke']);
    const revoker = await createUser({ roles: ['user', 'staff', 'test_revoker'] });
    expect(await queueApproverDigest(mondayNine)).toBe(1); // super_admin เท่านั้น
    expect(await queuedEmails(revoker.id)).toEqual([]);
  });
});
