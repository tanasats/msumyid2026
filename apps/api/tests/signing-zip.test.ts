import { randomBytes } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { signPdf, TimestampError } from '../src/services/pdf-signing/index.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { MAX_ATTEMPTS, processNextExtraction, processNextSigningJob, signingEngine } from '../src/services/signing-worker-service.js';
import { safeEntryPath } from '../src/services/signing-zip.js';
import { storage, StorageError } from '../src/storage/index.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import { createFakeSigning } from './helpers/fake-signing.js';
import { useMemoryStorage } from './helpers/storage.js';
import { buildZip, type RawEntry } from './helpers/zip.js';

// ลงนามหลายไฟล์ด้วย ZIP (ระยะ D3): แตก ZIP อย่างปลอดภัยที่ worker, ลงนามทีละไฟล์, ลองใหม่, ดาวน์โหลดรวม
// ฐานข้อมูล app_test จริง storage ในหน่วยความจำ signer/TSA จำลองด้วย OpenSSL

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const DAY = 24 * 60 * 60 * 1000;
const PIN = '482915';

const fake = createFakeSigning();
let memory: ReturnType<typeof useMemoryStorage>;

beforeEach(async () => {
  await resetDatabase();
  memory = useMemoryStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  fake.cleanup();
  await resetDatabase();
  await pool.end();
});

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

function useFakeSigning(tsa = fake.fakeTsa) {
  fake.mockSigner();
  vi.spyOn(signingEngine, 'signPdf').mockImplementation((pdf, options) => signPdf(pdf, { ...options, tsaTransport: tsa }));
  // LTV ทดสอบแยกใน ltv.test.ts / signing.test.ts — ที่นี่ปิดไว้ ไฟล์ผลลัพธ์จึงครอบคลุมทั้งไฟล์เหมือนเดิม
  vi.spyOn(signingEngine, 'collectRevocationMaterial').mockResolvedValue({ material: null, reason: 'ปิดใน test' });
}

async function signerUser() {
  await createTestRole('test_sign', ['document:sign']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_sign'] });
  const cookie = await loginAs(user.id);
  expect((await request(app).put('/me/signing-pin').set('Cookie', cookie).set('Origin', ORIGIN).send({ newPin: PIN })).status).toBe(200);
  return { ...user, cookie };
}

async function insertCertificate(userId: string) {
  const notAfter = new Date(Date.now() + 365 * DAY);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'ผู้ลงนาม', 'signer@msu.ac.th', $3, $4, 'issued', 'PEM', $5)
     RETURNING id`,
    [userId, `1${randomBytes(15).toString('hex')}`, new Date(notAfter.getTime() - 365 * DAY), notAfter, randomBytes(32).toString('hex')],
  );
  await pool.query(
    `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id) VALUES ($1, $2, $3, 'test-1')`,
    [rows[0]!.id, randomBytes(40), randomBytes(60)],
  );
  return rows[0]!.id;
}

async function samplePdf(label = 'doc'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(label, { x: 50, y: 780, font, size: 14 });
  return Buffer.from(await doc.save());
}

async function uploadZip(cookie: string, zip: Buffer, name = 'เอกสารชุด.zip') {
  const created = await post(cookie, '/me/files', { purpose: 'signing_source', originalName: name, mimeType: 'application/zip', size: zip.length });
  expect(created.status).toBe(201);
  memory.upload(created.body.uploadUrl, zip, 'application/zip');
  expect((await post(cookie, `/me/files/${created.body.file.id}/complete`)).status).toBe(200);
  return created.body.file.id as string;
}

/** ส่ง ZIP เข้าคิว คืนผู้ใช้ + ชุด (สถานะ extracting) */
async function submitZip(entries: RawEntry[] | Buffer) {
  const user = await signerUser();
  const certificateId = await insertCertificate(user.id);
  const fileId = await uploadZip(user.cookie, Buffer.isBuffer(entries) ? entries : buildZip(entries));
  const res = await post(user.cookie, '/me/signing-batches', { fileId, certificateId, lockDocument: false, pin: PIN });
  expect(res.status).toBe(202);
  return { user, certificateId, batch: res.body.batch };
}

const getBatch = (cookie: string, id: string) => request(app).get(`/me/signing-batches/${id}`).set('Cookie', cookie);
const counts = async () =>
  (await pool.query(`SELECT (SELECT count(*)::int FROM signing_jobs) AS jobs, (SELECT count(*)::int FROM files WHERE purpose = 'signing_source') AS files`))
    .rows[0] as { jobs: number; files: number };

async function drainSigning() {
  while (await processNextSigningJob()) {
    // ลงนามจนคิวว่าง
  }
}

/** อ่าน ZIP ที่ดาวน์โหลด: ชื่อ → เนื้อไฟล์ */
async function unzip(data: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(data, { lazyEntries: true });
  const out = new Map<string, Buffer>();
  for await (const entry of zip.eachEntry()) {
    const chunks: Buffer[] = [];
    for await (const chunk of (await zip.openReadStreamPromise(entry)) as AsyncIterable<Buffer>) chunks.push(chunk);
    out.set(entry.fileName, Buffer.concat(chunks));
  }
  return out;
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('แตก ZIP', () => {
  it('PDF ในโฟลเดอร์ → งานต่อไฟล์ / ข้าม: ไม่ใช่ PDF, ZIP ซ้อน, path ../, ชื่อซ้ำ / ไฟล์ขยะของ macOS ข้ามเงียบ ๆ', async () => {
    const pdf = await samplePdf();
    const { user, batch } = await submitZip([
      { name: 'ชุดที่ 1/ใบที่ 1.pdf', data: pdf },
      { name: 'ใบที่ 2.PDF', data: pdf, deflate: false },
      { name: 'อ่านก่อน.txt', data: Buffer.from('hello') },
      { name: 'ซ้อน.zip', data: buildZip([{ name: 'x.pdf', data: pdf }]) },
      { name: '../หลุด.pdf', data: pdf },
      { name: 'ชุดที่ 1/ใบที่ 1.PDF', data: pdf },
      { name: '__MACOSX/ชุดที่ 1/._ใบที่ 1.pdf', data: Buffer.from('junk') },
      { name: 'ชุดที่ 1/', data: Buffer.alloc(0) },
    ]);
    expect(batch).toMatchObject({ status: 'extracting', source: 'zip', zipName: 'เอกสารชุด.zip', jobs: [] });

    expect(await processNextExtraction()).toBe(true);
    expect(await processNextExtraction()).toBe(false);
    const res = (await getBatch(user.cookie, batch.id)).body.batch;
    expect(res.status).toBe('processing');
    expect(res.jobs.map((j: { originalName: string }) => j.originalName)).toEqual(['ชุดที่ 1/ใบที่ 1.pdf', 'ใบที่ 2.PDF']);
    expect(res.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason])).toEqual([
      ['อ่านก่อน.txt', 'NOT_PDF'],
      ['ซ้อน.zip', 'NESTED_ARCHIVE'],
      ['../หลุด.pdf', 'UNSAFE_PATH'],
      ['ชุดที่ 1/ใบที่ 1.PDF', 'DUPLICATE_NAME'],
    ]);
    expect(res.skipped[0].message).toBe('ไม่ใช่ PDF');
    // ไฟล์ที่แตกเก็บเป็นไฟล์ต้นฉบับของผู้ใช้ หมดอายุพร้อมชุด
    const { rows } = await pool.query(
      `SELECT f.original_name, f.uploaded_by, f.expires_at = b.expires_at AS same_expiry
       FROM signing_jobs j JOIN files f ON f.id = j.source_file_id JOIN signing_batches b ON b.id = j.batch_id ORDER BY j.id`,
    );
    expect(rows).toEqual([
      { original_name: 'ใบที่ 1.pdf', uploaded_by: user.id, same_expiry: true },
      { original_name: 'ใบที่ 2.PDF', uploaded_by: user.id, same_expiry: true },
    ]);
  });

  it('ชื่อไฟล์ภาษาไทยแบบ TIS-620 (ZIP จาก Windows ไม่ตั้ง flag UTF-8) ถอดถูก', async () => {
    // "ใบ" ใน TIS-620 = 0xE3 0xBA
    const name = Buffer.concat([Buffer.from([0xe3, 0xba]), Buffer.from('-1.pdf', 'latin1')]);
    const { user, batch } = await submitZip([{ name, data: await samplePdf() }]);
    await processNextExtraction();
    expect((await getBatch(user.cookie, batch.id)).body.batch.jobs[0].originalName).toBe('ใบ-1.pdf');
  });

  it('ZIP bomb (บีบอัดเกิน 100 เท่า) / PDF เกิน 100 ไฟล์ / ไม่ใช่ ZIP / ไม่มี PDF → ทั้งชุดล้มเหลว ไม่สร้างงาน ไม่เหลือไฟล์ที่แตก', async () => {
    const cases: [RawEntry[] | Buffer, string][] = [
      [[{ name: 'bomb.pdf', data: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2 * 1024 * 1024)]) }], 'ZIP_BOMB'],
      [Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.pdf`, data: Buffer.from(`%PDF-1.7 ${i}`), deflate: false })), 'ZIP_TOO_MANY_FILES'],
      [Buffer.from('this is not a zip file at all'), 'ZIP_INVALID'],
      [[{ name: 'note.txt', data: Buffer.from('x') }], 'ZIP_NO_PDF'],
    ];
    for (const [entries, code] of cases) {
      const { user, batch } = await submitZip(entries);
      await processNextExtraction();
      const res = (await getBatch(user.cookie, batch.id)).body.batch;
      expect(res).toMatchObject({ status: 'failed', error: { code, retryable: false }, canRetry: false, jobs: [] });
    }
    expect(await counts()).toEqual({ jobs: 0, files: 4 }); // เหลือเฉพาะไฟล์ ZIP ที่อัปโหลด
    expect([...memory.objects.keys()].filter((k) => k.startsWith('signing-source/')).length).toBe(4);
  });

  it('บัญชีถูกปิดก่อนแตก ZIP → ทั้งชุดล้มเหลว ACCOUNT_NOT_ALLOWED ไม่แตกไฟล์', async () => {
    const { user, batch } = await submitZip([{ name: 'a.pdf', data: await samplePdf() }]);
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
    await processNextExtraction();
    const { rows } = await pool.query('SELECT status, error_code FROM signing_batches WHERE id = $1', [batch.id]);
    expect(rows[0]).toEqual({ status: 'failed', error_code: 'ACCOUNT_NOT_ALLOWED' });
    expect((await counts()).jobs).toBe(0);
  });

  it('storage ล่มระหว่างแตก → ลองใหม่ภายหลัง / ครบ 3 ครั้ง → ล้มเหลว (ลองใหม่ได้) → กดลองใหม่ด้วย PIN = แตกใหม่ทั้งชุด', async () => {
    const { user, batch } = await submitZip([{ name: 'a.pdf', data: await samplePdf() }]);
    // storage จำลองล่มเฉพาะการอ่าน ZIP แล้วกลับมาใช้ได้ (ไม่ใช้ mockRestore ซึ่งคืนเป็น S3 จริง)
    let down = true;
    const memoryRange = vi.mocked(storage.getRangeStream).getMockImplementation()!;
    vi.mocked(storage.getRangeStream).mockImplementation(async (...args) => {
      if (down) throw new StorageError('ล่ม');
      return memoryRange(...args);
    });
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await processNextExtraction();
      const { rows } = await pool.query('SELECT status, error_code, extract_run_after > now() AS later FROM signing_batches WHERE id = $1', [batch.id]);
      expect(rows[0]).toEqual({ status: 'extracting', error_code: 'STORAGE_UNAVAILABLE', later: true });
      await pool.query('UPDATE signing_batches SET extract_run_after = now() WHERE id = $1', [batch.id]);
    }
    await processNextExtraction();
    const failed = (await getBatch(user.cookie, batch.id)).body.batch;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'STORAGE_UNAVAILABLE', retryable: true }, canRetry: true });

    down = false;
    expect((await post(user.cookie, `/me/signing-batches/${batch.id}/retry`, { pin: '000001' })).body.error.code).toBe('PIN_INCORRECT');
    const retried = await post(user.cookie, `/me/signing-batches/${batch.id}/retry`, { pin: PIN });
    expect(retried.status).toBe(202);
    expect(retried.body.batch).toMatchObject({ status: 'extracting', error: null });
    await processNextExtraction();
    expect((await getBatch(user.cookie, batch.id)).body.batch.jobs).toHaveLength(1);
  });
});

describe('ลงนามและดาวน์โหลดรวม', () => {
  it('ลงนามทุกไฟล์ → ดาวน์โหลด ZIP ที่คงชื่อและโฟลเดอร์เดิม ทุกไฟล์ตรวจผ่าน', async () => {
    useFakeSigning();
    const { user, batch } = await submitZip([
      { name: 'ชุดที่ 1/ใบที่ 1.pdf', data: await samplePdf('one') },
      { name: 'ใบที่ 2.pdf', data: await samplePdf('two') },
    ]);
    await processNextExtraction();
    await drainSigning();
    const done = (await getBatch(user.cookie, batch.id)).body.batch;
    expect(done.status).toBe('completed');
    expect(done.jobs.every((j: { status: string }) => j.status === 'signed')).toBe(true);

    const res = await request(app).get(`/me/signing-batches/${batch.id}/download`).set('Cookie', user.cookie).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(decodeURIComponent(res.headers['content-disposition']!)).toContain('เอกสารชุด-signed.zip');
    const files = await unzip(res.body as Buffer);
    expect([...files.keys()]).toEqual(['ชุดที่ 1/ใบที่ 1.pdf', 'ใบที่ 2.pdf']);
    for (const pdf of files.values()) {
      expect((await verifyPdfSignatures(pdf)).signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });
    }
  });

  it('ดาวน์โหลด: ยังไม่มีไฟล์ที่ลงนาม → 409 / ชุดของคนอื่น → 404 / เลย 7 วัน → 410', async () => {
    const { user, batch } = await submitZip([{ name: 'a.pdf', data: await samplePdf() }]);
    const path = `/me/signing-batches/${batch.id}/download`;
    expect((await request(app).get(path).set('Cookie', user.cookie)).body.error.code).toBe('NO_SIGNED_FILES');
    const other = await signerUser();
    expect((await request(app).get(path).set('Cookie', other.cookie)).status).toBe(404);
    await pool.query(`UPDATE signing_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [batch.id]);
    expect((await request(app).get(path).set('Cookie', user.cookie)).status).toBe(410);
  });

  it('TSA ล่มบางไฟล์ → ชุดจบพร้อมไฟล์ที่ลองใหม่ได้ → ลองใหม่ด้วย PIN คืนเฉพาะไฟล์ชั่วคราว (ไฟล์เสียไม่แตะ)', async () => {
    let tsaDown = true;
    useFakeSigning(async (query) => {
      if (tsaDown) throw new TimestampError('TSA ล่ม');
      return fake.fakeTsa(query);
    });
    const { user, batch } = await submitZip([
      { name: 'good.pdf', data: await samplePdf() },
      { name: 'broken.pdf', data: Buffer.from('not really a pdf') },
    ]);
    await processNextExtraction();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await drainSigning();
      await pool.query(`UPDATE signing_jobs SET run_after = now() WHERE status = 'pending'`);
    }
    const failed = (await getBatch(user.cookie, batch.id)).body.batch;
    expect(failed.status).toBe('failed');
    expect(failed.canRetry).toBe(true);
    expect(failed.jobs.map((j: { error: { code: string; retryable: boolean } }) => j.error)).toEqual([
      expect.objectContaining({ code: 'TSA_UNAVAILABLE', retryable: true }),
      expect.objectContaining({ code: 'NOT_PDF', retryable: false }),
    ]);

    tsaDown = false;
    const retried = await post(user.cookie, `/me/signing-batches/${batch.id}/retry`, { pin: PIN });
    expect(retried.body.batch.status).toBe('processing');
    expect(retried.body.batch.jobs.map((j: { status: string }) => j.status)).toEqual(['pending', 'failed']);
    await drainSigning();
    const done = (await getBatch(user.cookie, batch.id)).body.batch;
    expect(done).toMatchObject({ status: 'completed', canRetry: false });
    expect((await post(user.cookie, `/me/signing-batches/${batch.id}/retry`, { pin: PIN })).body.error.code).toBe('NOTHING_TO_RETRY');
  });
});

describe('safeEntryPath', () => {
  it('ปฏิเสธ absolute, ไดรฟ์, .., ส่วนว่าง, อักขระควบคุม / แปลง \\ เป็น /', () => {
    expect(safeEntryPath('a/b.pdf')).toBe('a/b.pdf');
    expect(safeEntryPath('a\\b.pdf')).toBe('a/b.pdf');
    for (const bad of ['/etc/a.pdf', 'C:/a.pdf', 'a/../b.pdf', '..\\b.pdf', 'a//b.pdf', './a.pdf', 'a\u0000.pdf']) {
      expect(safeEntryPath(bad)).toBeNull();
    }
  });
});
