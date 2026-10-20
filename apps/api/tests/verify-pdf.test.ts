import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { trustStore } from '../src/services/signature-verification/trust-store.js';
import { extractPdfSignatures, parsePdfDate } from '../src/services/signature-verification/pdf-signatures.js';
import { resetDatabase } from './helpers/db.js';
import {
  createSignedPdf,
  createTestCertificate,
  fingerprintOf,
  pemOf,
  serialOf,
  type TestCertificate,
} from './helpers/signed-pdf.js';

// ตรวจลายมือชื่อบนเอกสาร PDF (POST /verify/pdf — สาธารณะ)
// ใช้ CA ปลอม (root → intermediate "มมส." → ผู้ลงนาม) แทน trust store จริง และฐานข้อมูล app_test จริงสำหรับสถานะการเพิกถอน

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let root: TestCertificate;
let msu: TestCertificate;
let signer: TestCertificate;
let otherRoot: TestCertificate;
let tsa: TestCertificate;

beforeAll(async () => {
  root = await createTestCertificate({ commonName: 'Test Root CA', isCa: true });
  msu = await createTestCertificate({ commonName: 'Test MSU CA', organization: 'Mahasarakham University', isCa: true, issuer: root });
  signer = await createTestCertificate({
    commonName: 'สมชาย ใจดี',
    organization: 'Mahasarakham University',
    email: 'somchai@msu.ac.th',
    issuer: msu,
    extKeyUsage: ['1.3.6.1.5.5.7.3.4'],
  });
  otherRoot = await createTestCertificate({ commonName: 'Untrusted Root', isCa: true });
  tsa = await createTestCertificate({ commonName: 'Test TSA', issuer: root, extKeyUsage: ['1.3.6.1.5.5.7.3.8'] });
});

beforeEach(async () => {
  await resetDatabase();
  vi.spyOn(trustStore, 'get').mockReturnValue({
    signerAnchors: [{ name: 'Test Root CA', certificate: root.certificate }],
    timestampAnchors: [{ name: 'Test Root CA', certificate: root.certificate }],
    intermediates: [msu.certificate],
    msuIssuer: msu.certificate,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

const verify = (pdf: Buffer) =>
  request(app).post('/verify/pdf').set('Origin', ORIGIN).set('Content-Type', 'application/pdf').send(pdf);

/** บันทึกใบผู้ลงนามในตาราง certificates (เหมือนใบที่ระบบออก) */
async function registerCertificate(cert: TestCertificate, revokedAt: Date | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO certificates (serial_number, subject_cn, email, not_before, not_after, revoked_at, revocation_reason,
                               source, certificate_pem, fingerprint_sha256)
     VALUES ($1, 'ทดสอบ', 'somchai@msu.ac.th', $2, $3, $4, $5, 'issued', $6, $7)`,
    [
      serialOf(cert.certificate),
      cert.certificate.notBefore.value,
      cert.certificate.notAfter.value,
      revokedAt,
      revokedAt ? 'keyCompromise' : null,
      pemOf(cert.certificate),
      fingerprintOf(cert.certificate),
    ],
  );
}

describe('POST /verify/pdf', () => {
  it('ใบของ มมส. ที่อยู่ในระบบและไม่ถูกเพิกถอน → ถูกต้อง', async () => {
    await registerCertificate(signer);
    const pdf = await createSignedPdf({ signer, signingTime: new Date(), reason: 'อนุมัติ' });

    const res = await verify(pdf);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.signatures).toHaveLength(1);
    const [sig] = res.body.signatures;
    expect(sig).toMatchObject({
      verdict: 'valid',
      kind: 'signature',
      integrity: 'ok',
      coversWholeDocument: true,
      issuedByUniversity: true,
      reason: 'อนุมัติ',
      chain: { status: 'trusted', anchor: 'Test Root CA' },
      revocation: { status: 'good' },
      signingTime: { source: 'claimed' },
    });
    expect(sig.signer).toMatchObject({ commonName: 'สมชาย ใจดี', email: 'somchai@msu.ac.th' });
    expect(sig.chain.path).toHaveLength(3);
  });

  it('แก้ไข 1 ไบต์ในส่วนที่ลงนาม → ไม่ถูกต้อง', async () => {
    await registerCertificate(signer);
    const pdf = await createSignedPdf({ signer });
    pdf[20] = pdf[20]! ^ 0x01;

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({ verdict: 'invalid', integrity: 'failed' });
  });

  it('ต่อท้ายไฟล์หลังลงนาม → ส่วนที่ลงนามยังถูกต้อง แต่แจ้งว่าไม่ครอบคลุมทั้งเอกสาร', async () => {
    await registerCertificate(signer);
    const pdf = Buffer.concat([await createSignedPdf({ signer }), Buffer.from('1 0 obj\n<< >>\nendobj\n%%EOF\n')]);

    const res = await verify(pdf);

    const [sig] = res.body.signatures;
    expect(sig).toMatchObject({ verdict: 'valid', coversWholeDocument: false });
    expect(sig.findings.some((f: { level: string }) => f.level === 'warning')).toBe(true);
  });

  it('ลงนาม 2 ครั้งต่อกัน → ลายมือชื่อแรกไม่ครอบคลุมทั้งเอกสาร ลายมือชื่อหลังครอบคลุม', async () => {
    await registerCertificate(signer);
    const first = await createSignedPdf({ signer });
    const both = await createSignedPdf({ signer }, first);

    const res = await verify(both);

    expect(res.body.signatures.map((s: { coversWholeDocument: boolean }) => s.coversWholeDocument)).toEqual([false, true]);
    expect(res.body.signatures.every((s: { verdict: string }) => s.verdict === 'valid')).toBe(true);
  });

  it('ใบที่ไม่ได้ออกภายใต้ root ที่เชื่อถือ → ไม่ทราบความถูกต้อง', async () => {
    const outsider = await createTestCertificate({ commonName: 'Outsider', issuer: otherRoot });
    const pdf = await createSignedPdf({ signer: outsider, chain: [otherRoot.certificate] });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({
      verdict: 'unknown',
      integrity: 'ok',
      chain: { status: 'untrusted', anchor: null },
      issuedByUniversity: false,
    });
  });

  it('ใบของ มมส. ที่ถูกเพิกถอนแล้ว (ไม่มีการประทับเวลา) → ไม่ถูกต้อง', async () => {
    await registerCertificate(signer, new Date());
    const pdf = await createSignedPdf({ signer });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({
      verdict: 'invalid',
      revocation: { status: 'revoked', reason: 'keyCompromise' },
    });
  });

  it('ประทับเวลาก่อนเพิกถอน → ยังถูกต้อง และใช้เวลาจากหน่วยประทับเวลา', async () => {
    const signedAt = new Date(Date.now() - 2 * HOUR);
    await registerCertificate(signer, new Date(Date.now() - HOUR));
    const pdf = await createSignedPdf({ signer, timestamp: { tsa, time: signedAt } });

    const res = await verify(pdf);

    const [sig] = res.body.signatures;
    expect(sig).toMatchObject({
      verdict: 'valid',
      timestamp: { status: 'valid', authority: 'Test TSA' },
      signingTime: { source: 'timestamp', value: signedAt.toISOString() },
      revocation: { status: 'good' },
    });
  });

  it('หน่วยประทับเวลาที่ไม่น่าเชื่อถือ → ไม่ใช้เวลานั้น', async () => {
    await registerCertificate(signer);
    const fakeTsa = await createTestCertificate({ commonName: 'Fake TSA', issuer: otherRoot, extKeyUsage: ['1.3.6.1.5.5.7.3.8'] });
    const pdf = await createSignedPdf({ signer, timestamp: { tsa: fakeTsa, time: new Date() } });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({
      verdict: 'valid',
      timestamp: { status: 'untrusted' },
      // ไม่เชื่อเวลาของ TSA นี้ จึงแสดงเวลาที่ผู้ลงนามระบุเอง (/M) แทน
      signingTime: { source: 'claimed' },
    });
  });

  it('ใบหมดอายุแล้วและไม่มีการประทับเวลา → ไม่ทราบความถูกต้อง', async () => {
    const expired = await createTestCertificate({
      commonName: 'Expired',
      issuer: msu,
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    await registerCertificate(expired);
    const pdf = await createSignedPdf({ signer: expired });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({ verdict: 'unknown', chain: { status: 'trusted' } });
  });

  it('ใบหมดอายุแล้ว แต่ประทับเวลาขณะใบยังใช้ได้ → ถูกต้อง', async () => {
    const expired = await createTestCertificate({
      commonName: 'Expired',
      issuer: msu,
      notBefore: new Date(Date.now() - 400 * DAY),
      notAfter: new Date(Date.now() - DAY),
    });
    await registerCertificate(expired);
    const pdf = await createSignedPdf({ signer: expired, timestamp: { tsa, time: new Date(Date.now() - 10 * DAY) } });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({ verdict: 'valid', timestamp: { status: 'valid' } });
  });

  it('ใบของ มมส. ที่ไม่อยู่ในระบบ → ไม่ทราบความถูกต้อง (ตรวจการเพิกถอนไม่ได้)', async () => {
    const pdf = await createSignedPdf({ signer });

    const res = await verify(pdf);

    expect(res.body.signatures[0]).toMatchObject({
      verdict: 'unknown',
      issuedByUniversity: true,
      revocation: { status: 'unknown' },
    });
  });

  it('PDF ที่ไม่มีลายมือชื่อ → ผลว่าง', async () => {
    const res = await verify(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'));

    expect(res.status).toBe(200);
    expect(res.body.signatures).toEqual([]);
  });

  it('ไม่ใช่ PDF → 400 NOT_PDF', async () => {
    const res = await verify(Buffer.from('hello world'));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_PDF');
  });

  it('ไม่ได้ส่ง Content-Type application/pdf → 400 PDF_REQUIRED', async () => {
    const res = await request(app).post('/verify/pdf').set('Origin', ORIGIN).send({ file: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PDF_REQUIRED');
  });

  it('ไฟล์ใหญ่เกิน 20 MB → 413', async () => {
    const res = await verify(Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('ไม่มี Origin → 403 (CSRF)', async () => {
    const res = await request(app).post('/verify/pdf').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.7'));

    expect(res.status).toBe(403);
  });

  it('ไม่ต้อง login', async () => {
    const res = await verify(Buffer.from('%PDF-1.7\n%%EOF\n'));

    expect(res.status).toBe(200);
  });
});

describe('extractPdfSignatures', () => {
  it('ไม่นับ /ByteRange ที่ช่องว่างไม่ใช่ <hex>', () => {
    const pdf = Buffer.from('%PDF-1.7\n/ByteRange [0 10 20 5] xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n');
    expect(extractPdfSignatures(pdf)).toEqual([]);
  });

  it('ไม่นับ /ByteRange ที่อยู่นอกส่วนที่ลงนาม', async () => {
    const pdf = await createSignedPdf({ signer });
    // ByteRange ปลอมต่อท้ายไฟล์ (นอกช่วงที่ลงนาม) ชี้ช่องว่าง <hex> เดิมแต่ช่วงต่างกัน — ต้องไม่นับเป็นลายมือชื่อที่ 2
    const [sig] = extractPdfSignatures(pdf);
    const [a, b, c, d] = sig!.byteRange;
    const fake = Buffer.concat([pdf, Buffer.from(`\n/ByteRange [${a} ${b} ${c} ${d - 1}]\n`)]);
    expect(extractPdfSignatures(fake)).toHaveLength(1);
  });

  it('อ่านวันที่แบบ PDF พร้อม timezone', () => {
    expect(parsePdfDate("D:20261016120000+07'00'")?.toISOString()).toBe('2026-10-16T05:00:00.000Z');
    expect(parsePdfDate('D:20261016')?.toISOString()).toBe('2026-10-16T00:00:00.000Z');
    expect(parsePdfDate('garbage')).toBeNull();
  });
});
