import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { buildMime, encodeHeaderText, isSendableAddress } from '../src/mail/mime.js';
import { EMAIL_RETRY_DELAYS_MINUTES, enqueueEmail, processEmailOutbox, purgeOldEmails } from '../src/mail/outbox.js';
import { EMAIL_TEMPLATES, renderEmail, type EmailNotice } from '../src/mail/templates.js';
import { MailError, mailTransport } from '../src/mail/transport.js';
import { createUser, resetDatabase } from './helpers/db.js';

// อีเมลแจ้งเตือน (docs/design/email.md) — MIME, แม่แบบ, คิว email_outbox กับฐานข้อมูลจริง (mock เฉพาะ mailTransport)

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

/** ถอด encoded-word (=?UTF-8?B?...?=) กลับเป็นข้อความ */
function decodeHeader(value: string): string {
  return value
    .split('\r\n ')
    .map((w) => {
      const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(w);
      return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : w;
    })
    .join('');
}

describe('MIME', () => {
  it('หัวเรื่องภาษาไทยยาว: แต่ละ encoded-word ไม่เกิน 75 ตัว ไม่ตัดกลางอักษร และถอดกลับได้ตรง', () => {
    const subject = 'คำขอใบรับรองประจำตัวได้รับอนุมัติแล้ว กรุณาเข้าสู่ระบบเพื่อรับใบรับรองภายใน 30 วัน';
    const encoded = encodeHeaderText(subject);
    for (const word of encoded.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeHeader(encoded)).toBe(subject);
    expect(encodeHeaderText('Plain ASCII')).toBe('Plain ASCII');
  });

  it('ข้อความ: base64 บรรทัดละไม่เกิน 76 ตัว + header ครบ / ชื่อผู้รับที่มีอักขระพิเศษถูกเข้ารหัส', () => {
    const mime = buildMime({
      from: { address: 'did@msu.ac.th', name: 'MSU Digital ID' },
      to: { address: 'user@msu.ac.th', name: 'Doe, "John" <x>' },
      subject: 'ทดสอบ',
      text: 'บรรทัดแรก\nบรรทัดสอง',
    });
    const [head, body] = mime.split('\r\n\r\n');
    expect(head).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(head).toContain('Auto-Submitted: auto-generated');
    expect(head).toMatch(/^To: =\?UTF-8\?B\?[^\r\n]+\?= <user@msu\.ac\.th>$/m);
    expect(decodeHeader(/^To: (.+) </m.exec(head!)![1]!)).toBe('Doe, "John" <x>');
    for (const line of body!.trim().split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('บรรทัดแรก\r\nบรรทัดสอง');
  });

  it('ผู้รับที่มีขึ้นบรรทัดใหม่/ช่องว่าง/<> → สร้างไม่ได้ (กัน header injection)', () => {
    expect(isSendableAddress('user@msu.ac.th')).toBe(true);
    for (const bad of ['user@msu.ac.th\r\nBcc: x@evil.com', 'a b@msu.ac.th', '<user@msu.ac.th>', 'user']) {
      expect(isSendableAddress(bad)).toBe(false);
    }
    expect(() =>
      buildMime({
        from: { address: 'did@msu.ac.th', name: 'MSU Digital ID' },
        to: { address: 'user@msu.ac.th\r\nBcc: x@evil.com', name: null },
        subject: 's',
        text: 't',
      }),
    ).toThrow();
  });
});

describe('แม่แบบ', () => {
  const samples: EmailNotice[] = [
    { template: 'account_approved', params: {} },
    { template: 'account_rejected', params: { reason: 'ไม่ใช่ผู้เกี่ยวข้อง' } },
    { template: 'primary_request_approved', params: { note: null } },
    { template: 'primary_request_rejected', params: { note: 'ยังไม่ผ่านการตรวจสอบ' } },
    { template: 'supplementary_request_approved', params: { startDate: '2026-11-05', endDate: '2026-11-30', note: null } },
    { template: 'supplementary_request_rejected', params: { note: 'ไม่มีภารกิจ' } },
    { template: 'revocation_request_rejected', params: { serialNumber: '1abc', note: 'ใช้ต่อได้' } },
    {
      template: 'certificate_revoked',
      params: { kind: 'primary', serialNumber: '1abc', reason: 'keyCompromise', by: 'self', note: null },
    },
    { template: 'certificate_downloaded', params: { kind: 'supplementary', serialNumber: '1abc' } },
    {
      template: 'certificate_expiring',
      params: { kind: 'primary', serialNumber: '1abc', notAfter: '2027-05-31T16:59:59.000Z', daysBefore: 30 },
    },
    { template: 'approver_digest', params: { primaryRequests: 3, revocationRequests: 1 } },
  ];

  it('ทุกแม่แบบแสดงผลได้: มีชื่อผู้รับ ลิงก์ไป WEB_URL และไม่มีค่าว่าง/undefined', () => {
    expect(samples.map((s) => s.template).sort()).toEqual([...EMAIL_TEMPLATES].sort());
    for (const notice of samples) {
      const { subject, text } = renderEmail(notice, { recipientName: 'สมชาย ใจดี', webUrl: 'https://did.msu.ac.th' });
      expect(subject.length).toBeGreaterThan(0);
      expect(text).toMatch(/^เรียน สมชาย ใจดี\n/);
      expect(text).toMatch(/https:\/\/did\.msu\.ac\.th\//);
      expect(`${subject}\n${text}`).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });

  it('ใส่เหตุผล/ช่วงวันที่/serial ที่ส่งมา (serial ตัวพิมพ์ใหญ่ วันที่ภาษาไทย)', () => {
    const rejected = renderEmail(samples[1]!, { recipientName: null, webUrl: 'https://did.msu.ac.th' });
    expect(rejected.text).toContain('เรียน ผู้ใช้งาน');
    expect(rejected.text).toContain('เหตุผล: ไม่ใช่ผู้เกี่ยวข้อง');
    const range = renderEmail(samples[4]!, { recipientName: null, webUrl: 'https://did.msu.ac.th' });
    expect(range.text).toContain('5 พฤศจิกายน 2569');
    expect(range.text).toContain('30 พฤศจิกายน 2569');
    const revoked = renderEmail(samples[7]!, { recipientName: null, webUrl: 'https://did.msu.ac.th' });
    expect(revoked.text).toContain('1ABC');
    expect(revoked.text).toContain('ถ้าคุณไม่ได้เพิกถอนเอง');
    const expiring = renderEmail(samples[9]!, { recipientName: null, webUrl: 'https://did.msu.ac.th' });
    expect(expiring.subject).toContain('อีก 30 วัน');
    expect(expiring.text).toContain('31 พฤษภาคม 2570');
    // สรุปงาน: เฉพาะคิวที่มีงาน พร้อมลิงก์ตรงไปคิวนั้น ยอดรวมในหัวเรื่อง
    const digest = renderEmail(samples[10]!, { recipientName: null, webUrl: 'https://did.msu.ac.th' });
    expect(digest.subject).toContain('4 รายการ');
    expect(digest.text).toContain('- คำขอใบรับรองประจำตัว 3 รายการ: https://did.msu.ac.th/admin/certificate-requests?type=primary');
    expect(digest.text).toContain('- คำขอเพิกถอนใบรับรอง 1 รายการ: https://did.msu.ac.th/admin/certificate-requests?type=revocation');
    expect(digest.text).not.toContain('บัญชีรออนุมัติ');
  });
});

describe('คิว email_outbox', () => {
  async function outboxRow(userId: string) {
    const { rows } = await pool.query(
      `SELECT status, attempts, last_error, sent_at IS NOT NULL AS sent,
              round(extract(epoch FROM next_attempt_at - now()) / 60) AS "minutesUntilNext"
       FROM email_outbox WHERE recipient_user_id = $1`,
      [userId],
    );
    return rows[0];
  }

  it('ส่งสำเร็จ: ส่งถึงอีเมล/ชื่อปัจจุบันของผู้ใช้ แล้วเป็น sent', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockResolvedValue();
    const user = await createUser({ email: 'somchai@msu.ac.th', name: 'สมชาย ใจดี' });
    await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });

    expect(await processEmailOutbox()).toEqual({ sent: 1, retry: 0, failed: 0, cancelled: 0, limited: false });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'somchai@msu.ac.th', toName: 'สมชาย ใจดี', subject: expect.stringContaining('อนุมัติ') }),
    );
    expect(await outboxRow(user.id)).toMatchObject({ status: 'sent', attempts: 1, sent: true, last_error: null });
    // ส่งแล้วไม่ส่งซ้ำ
    expect(await processEmailOutbox()).toEqual({ sent: 0, retry: 0, failed: 0, cancelled: 0, limited: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ส่งไม่สำเร็จชั่วคราว → ลองใหม่ตามรอบ ครบทุกรอบแล้ว → failed', async () => {
    vi.spyOn(mailTransport, 'send').mockRejectedValue(new MailError('Gmail API ตอบ HTTP 503', false));
    const user = await createUser();
    await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });

    expect((await processEmailOutbox()).retry).toBe(1);
    expect(await outboxRow(user.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_error: 'Gmail API ตอบ HTTP 503',
      minutesUntilNext: String(EMAIL_RETRY_DELAYS_MINUTES[0]),
    });
    // ยังไม่ถึงเวลา → ไม่ลองซ้ำ
    expect((await processEmailOutbox()).retry).toBe(0);

    // ข้ามไปครั้งสุดท้าย
    await pool.query(
      `UPDATE email_outbox SET attempts = $1, next_attempt_at = now() WHERE recipient_user_id = $2`,
      [EMAIL_RETRY_DELAYS_MINUTES.length, user.id],
    );
    expect((await processEmailOutbox()).failed).toBe(1);
    expect(await outboxRow(user.id)).toMatchObject({ status: 'failed', attempts: EMAIL_RETRY_DELAYS_MINUTES.length + 1 });
  });

  it('error ถาวร (เช่น ผู้รับผิดรูปแบบ) → failed ทันทีไม่ลองซ้ำ / error อื่นที่ไม่ใช่ MailError → ลองใหม่', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockRejectedValueOnce(new MailError('HTTP 400', true));
    const first = await createUser();
    await enqueueEmail(pool, first.id, { template: 'account_approved', params: {} });
    expect((await processEmailOutbox()).failed).toBe(1);
    expect(await outboxRow(first.id)).toMatchObject({ status: 'failed', attempts: 1 });

    send.mockRejectedValueOnce(new Error('ECONNRESET'));
    const second = await createUser();
    await enqueueEmail(pool, second.id, { template: 'account_approved', params: {} });
    expect((await processEmailOutbox()).retry).toBe(1);
  });

  it('ผู้รับถูกลบบัญชี (soft delete) ระหว่างรอ → cancelled ไม่ส่ง', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockResolvedValue();
    const user = await createUser();
    await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });
    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [user.id]);

    expect((await processEmailOutbox()).cancelled).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(await outboxRow(user.id)).toMatchObject({ status: 'cancelled' });
  });

  it('แม่แบบที่ไม่มีแล้ว → failed ไม่ส่ง', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockResolvedValue();
    const user = await createUser();
    await pool.query(`INSERT INTO email_outbox (recipient_user_id, template) VALUES ($1, 'removed_template')`, [user.id]);
    expect((await processEmailOutbox()).failed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('ลบอีเมลที่เก่ากว่า 30 วันทุกสถานะ (PDPA) แต่คงอีเมลใหม่', async () => {
    const user = await createUser();
    await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });
    await enqueueEmail(pool, user.id, { template: 'account_rejected', params: { reason: 'เก่า' } });
    await pool.query(
      `UPDATE email_outbox SET created_at = now() - interval '31 days' WHERE template = 'account_rejected'`,
    );
    expect(await purgeOldEmails()).toBe(1);
    const { rows } = await pool.query(`SELECT template FROM email_outbox`);
    expect(rows).toEqual([{ template: 'account_approved' }]);
  });
});

describe('ลำดับและเพดานต่อวัน', () => {
  it('อีเมลปกติส่งก่อนเตือนใบใกล้หมดอายุ แม้เข้าคิวทีหลัง', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockResolvedValue();
    const user = await createUser();
    await enqueueEmail(pool, user.id, {
      template: 'certificate_expiring',
      params: { kind: 'primary', serialNumber: '1abc', notAfter: new Date().toISOString(), daysBefore: 30 },
    });
    await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });

    await processEmailOutbox(new Date(), 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].subject).toContain('อนุมัติ');
  });

  it('ครบเพดานใน 24 ชั่วโมง → หยุดส่ง (limited) ที่เหลือยังรอในคิว', async () => {
    const send = vi.spyOn(mailTransport, 'send').mockResolvedValue();
    const user = await createUser();
    for (let i = 0; i < 3; i++) await enqueueEmail(pool, user.id, { template: 'account_approved', params: {} });

    expect(await processEmailOutbox(new Date(), 2)).toMatchObject({ sent: 2, limited: true });
    expect(await processEmailOutbox(new Date(), 2)).toMatchObject({ sent: 0, limited: true });
    expect(send).toHaveBeenCalledTimes(2);
    // ส่งไปเมื่อเกิน 24 ชั่วโมงแล้วไม่นับ
    await pool.query(`UPDATE email_outbox SET sent_at = now() - interval '25 hours' WHERE status = 'sent'`);
    expect(await processEmailOutbox(new Date(), 2)).toMatchObject({ sent: 1, limited: false });
  });
});
