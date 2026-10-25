import { randomBytes } from 'node:crypto';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { claimNextSigningJob } from '../src/repositories/signing-repository.js';
import { signPdf, TimestampError } from '../src/services/pdf-signing/index.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import {
  MAX_ATTEMPTS,
  processNextSigningJob,
  requeueStaleJobs,
  signedFileName,
  signingEngine,
} from '../src/services/signing-worker-service.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import { createFakeSigning } from './helpers/fake-signing.js';
import { useMemoryStorage } from './helpers/storage.js';

// ลงนามเอกสารบนเว็บ (ระยะ D1): ส่งเข้าคิว (ตรวจไฟล์/ใบ/PIN) → worker ลงนาม → ดาวน์โหลด + audit log
// ฐานข้อมูลใช้ app_test จริง storage ในหน่วยความจำ signer/TSA จำลองด้วย OpenSSL

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

/** ลงนามด้วย signer และ TSA จำลอง (แทนที่ระดับเครื่องมือลงนาม ส่วนอื่นของ worker เป็นของจริง) */
function useFakeSigning(tsa = fake.fakeTsa) {
  fake.mockSigner();
  return vi.spyOn(signingEngine, 'signPdf').mockImplementation((pdf, options) => signPdf(pdf, { ...options, tsaTransport: tsa }));
}

async function signerUser(input: { withPin?: boolean } = {}) {
  await createTestRole('test_sign', ['document:sign']).catch(() => {});
  const user = await createUser({ name: 'สมชาย ลงนาม', roles: ['user', 'staff', 'test_sign'] });
  const cookie = await loginAs(user.id);
  if (input.withPin ?? true) {
    expect((await request(app).put('/me/signing-pin').set('Cookie', cookie).set('Origin', ORIGIN).send({ newPin: PIN })).status).toBe(200);
  }
  return { ...user, cookie };
}

async function insertCertificate(userId: string, input: { revoked?: boolean; expired?: boolean; escrow?: boolean } = {}) {
  const notAfter = new Date(Date.now() + (input.expired ? -DAY : 365 * DAY));
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                               revoked_at, revocation_reason, source, certificate_pem, fingerprint_sha256)
     VALUES ($1, $2, 'สมชาย ลงนาม', 'somchai@msu.ac.th', $3, $4, $5, $6, 'issued', '-----BEGIN CERTIFICATE-----\nPEM', $7)
     RETURNING id`,
    [
      userId,
      `1${randomBytes(15).toString('hex')}`,
      new Date(notAfter.getTime() - 365 * DAY),
      notAfter,
      input.revoked ? new Date() : null,
      input.revoked ? 'superseded' : null,
      randomBytes(32).toString('hex'),
    ],
  );
  const id = rows[0]!.id;
  if (input.escrow ?? true) {
    await pool.query(
      `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id) VALUES ($1, $2, $3, 'test-1')`,
      [id, randomBytes(40), randomBytes(60)],
    );
  }
  return id;
}

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Signing test', { x: 50, y: 780, font, size: 14 });
  return Buffer.from(await doc.save());
}

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

/** อัปโหลดผ่าน presigned URL (จำลอง) แล้วยืนยัน — คืน file id */
async function uploadPdf(cookie: string, body: Buffer, input: { name?: string; mimeType?: string; complete?: boolean } = {}) {
  const mimeType = input.mimeType ?? 'application/pdf';
  const created = await post(cookie, '/me/files', {
    purpose: 'signing_source',
    originalName: input.name ?? 'คำสั่ง ที่ 1-2569.pdf',
    mimeType,
    size: body.length,
  });
  expect(created.status).toBe(201);
  memory.upload(created.body.uploadUrl, body, mimeType);
  if (input.complete ?? true) expect((await post(cookie, `/me/files/${created.body.file.id}/complete`)).status).toBe(200);
  return created.body.file.id as string;
}

const submit = (cookie: string, body: object) => post(cookie, '/me/signing-batches', body);

async function submitted(input: { lockDocument?: boolean; pdf?: Buffer } = {}) {
  const user = await signerUser();
  const certificateId = await insertCertificate(user.id);
  const fileId = await uploadPdf(user.cookie, input.pdf ?? (await samplePdf()));
  const res = await submit(user.cookie, { fileId, certificateId, lockDocument: input.lockDocument ?? false, pin: PIN });
  expect(res.status).toBe(202);
  return { user, certificateId, fileId, batch: res.body.batch };
}

const getBatch = (cookie: string, id: string) => request(app).get(`/me/signing-batches/${id}`).set('Cookie', cookie);

const jobRow = async (batchId: string) =>
  (await pool.query('SELECT status, error_code, attempts, run_after FROM signing_jobs WHERE batch_id = $1', [batchId])).rows[0];

const signAuditLogs = async (certificateId: string) =>
  (await pool.query(`SELECT actor_id, reason FROM certificate_audit_logs WHERE certificate_id = $1 AND action = 'sign'`, [certificateId]))
    .rows;

describe('ส่งเข้าคิวลงนาม', () => {
  it('ยังไม่ login → 401 / ไม่มี document:sign → 403', async () => {
    expect((await request(app).post('/me/signing-batches').set('Origin', ORIGIN).send({})).status).toBe(401);
    const none = await createUser();
    const cookie = await loginAs(none.id);
    expect((await submit(cookie, {})).status).toBe(403);
    expect((await request(app).get('/me/signing-batches').set('Cookie', cookie)).status).toBe(403);
  });

  it('สำเร็จ: 202 ชุดไฟล์เดียวรอคิว เก็บชื่อไฟล์เดิม ไฟล์หมดอายุ 7 วัน', async () => {
    const { batch } = await submitted({ lockDocument: true });
    expect(batch).toMatchObject({ status: 'processing', source: 'single', lockDocument: true });
    expect(batch.jobs).toEqual([
      expect.objectContaining({ originalName: 'คำสั่ง ที่ 1-2569.pdf', status: 'pending', error: null, signedFileId: null }),
    ]);
    expect(Math.round((Date.parse(batch.expiresAt) - Date.now()) / DAY)).toBe(7);
  });

  it('ไฟล์ของคนอื่น / ยังไม่ยืนยันอัปโหลด / ZIP → ปฏิเสธ ไม่สร้างชุด', async () => {
    const user = await signerUser();
    const certificateId = await insertCertificate(user.id);
    const other = await signerUser();
    const othersFile = await uploadPdf(other.cookie, await samplePdf());
    const pending = await uploadPdf(user.cookie, await samplePdf(), { complete: false });
    const zip = await uploadPdf(user.cookie, Buffer.from('PK\u0003\u0004zip'), { name: 'a.zip', mimeType: 'application/zip' });

    const body = { certificateId, lockDocument: false, pin: PIN };
    expect((await submit(user.cookie, { ...body, fileId: othersFile })).body.error.code).toBe('FILE_NOT_FOUND');
    expect((await submit(user.cookie, { ...body, fileId: pending })).body.error.code).toBe('FILE_NOT_READY');
    expect((await submit(user.cookie, { ...body, fileId: zip })).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((await pool.query('SELECT count(*)::int AS n FROM signing_batches')).rows[0].n).toBe(0);
  });

  it('ใบของคนอื่น → 404 / เพิกถอน, หมดอายุ, ไม่มี key สำรอง → 409 CERTIFICATE_NOT_USABLE (ไม่นับ PIN ผิด)', async () => {
    const user = await signerUser();
    const fileId = await uploadPdf(user.cookie, await samplePdf());
    const other = await createUser();
    const body = { fileId, lockDocument: false, pin: '000001' };

    expect((await submit(user.cookie, { ...body, certificateId: await insertCertificate(other.id) })).body.error.code).toBe(
      'CERTIFICATE_NOT_FOUND',
    );
    for (const options of [{ revoked: true }, { expired: true }, { escrow: false }]) {
      const res = await submit(user.cookie, { ...body, certificateId: await insertCertificate(user.id, options) });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CERTIFICATE_NOT_USABLE');
    }
    // ตรวจใบก่อน PIN: PIN ผิดข้างบนยังไม่ถูกนับ
    expect((await pool.query('SELECT failed_attempts FROM signing_pins WHERE user_id = $1', [user.id])).rows[0].failed_attempts).toBe(0);
  });

  it('PIN ผิด → 403 PIN_INCORRECT (นับครั้ง) / ยังไม่ตั้ง PIN → 409 PIN_NOT_SET / ไม่สร้างชุด', async () => {
    const user = await signerUser();
    const certificateId = await insertCertificate(user.id);
    const fileId = await uploadPdf(user.cookie, await samplePdf());
    const res = await submit(user.cookie, { fileId, certificateId, lockDocument: false, pin: '000001' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PIN_INCORRECT');

    const noPin = await signerUser({ withPin: false });
    const noPinFile = await uploadPdf(noPin.cookie, await samplePdf());
    const noPinRes = await submit(noPin.cookie, {
      fileId: noPinFile,
      certificateId: await insertCertificate(noPin.id),
      lockDocument: false,
      pin: PIN,
    });
    expect(noPinRes.body.error.code).toBe('PIN_NOT_SET');
    expect((await pool.query('SELECT count(*)::int AS n FROM signing_batches')).rows[0].n).toBe(0);
  });

  it('ชุดของคนอื่น → 404 / ประวัติแสดงเฉพาะของตัวเอง', async () => {
    const { user, batch } = await submitted();
    const other = await signerUser();
    expect((await getBatch(other.cookie, batch.id)).status).toBe(404);
    expect((await request(app).get('/me/signing-batches').set('Cookie', other.cookie)).body.batches).toEqual([]);
    const list = await request(app).get('/me/signing-batches').set('Cookie', user.cookie);
    expect(list.body.batches).toEqual([
      expect.objectContaining({ id: batch.id, firstName: 'คำสั่ง ที่ 1-2569.pdf', totalJobs: 1, signedJobs: 0, firstSignedFileId: null }),
    ]);
  });
});

describe('worker ลงนาม', () => {
  it('ลงนามสำเร็จ: ไฟล์ผลลัพธ์ตรวจผ่าน ดาวน์โหลดได้ด้วยชื่อ -signed.pdf + audit log (sign) เก็บ SHA-256 ไม่เก็บชื่อไฟล์', async () => {
    useFakeSigning();
    const { user, certificateId, batch } = await submitted();
    expect(await processNextSigningJob()).toBe(true);
    expect(await processNextSigningJob()).toBe(false);

    const res = await getBatch(user.cookie, batch.id);
    expect(res.body.batch.status).toBe('completed');
    const [job] = res.body.batch.jobs;
    expect(job).toMatchObject({ status: 'signed', error: null });

    const { rows } = await pool.query(
      'SELECT object_key, purpose, original_name, uploaded_by, sha256, status FROM files WHERE id = $1',
      [job.signedFileId],
    );
    expect(rows[0]).toMatchObject({ purpose: 'signing_result', original_name: 'คำสั่ง ที่ 1-2569-signed.pdf', uploaded_by: user.id, status: 'uploaded' });
    const signed = memory.objects.get(rows[0].object_key)!.body;
    const report = await verifyPdfSignatures(signed);
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true, name: 'สมชาย ลงนาม' });

    const download = await request(app).get(`/me/files/${job.signedFileId}/download`).set('Cookie', user.cookie);
    expect(download.body.url).toContain(encodeURIComponent('คำสั่ง ที่ 1-2569-signed.pdf'));

    const logs = await signAuditLogs(certificateId);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor_id).toBe(user.id);
    expect(logs[0].reason).toMatch(new RegExp(`^document_sha256=[0-9a-f]{64} signed_sha256=${rows[0].sha256}$`));
    expect(logs[0].reason).not.toContain('คำสั่ง');

    const list = await request(app).get('/me/signing-batches').set('Cookie', user.cookie);
    expect(list.body.batches[0]).toMatchObject({ status: 'completed', signedJobs: 1, firstSignedFileId: job.signedFileId });
  });

  it('ล็อกเอกสาร → certification signature (DocMDP P=1)', async () => {
    useFakeSigning();
    const { batch } = await submitted({ lockDocument: true });
    await processNextSigningJob();
    const { rows } = await pool.query(
      `SELECT f.object_key FROM signing_jobs j JOIN files f ON f.id = j.signed_file_id WHERE j.batch_id = $1`,
      [batch.id],
    );
    const doc = await PDFDocument.load(memory.objects.get(rows[0].object_key)!.body);
    expect(doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict)?.has(PDFName.of('DocMDP'))).toBe(true);
    expect((await verifyPdfSignatures(memory.objects.get(rows[0].object_key)!.body)).signatures[0]!.integrity).toBe('ok');
  });

  it('ใบถูกเพิกถอน / บัญชีถูกปิด หลังส่งเข้าคิว → ล้มเหลว ไม่เรียก signer ไม่มี audit log', async () => {
    const engine = useFakeSigning();
    const revokedCase = await submitted();
    await pool.query(`UPDATE certificates SET revoked_at = now(), revocation_reason = 'keyCompromise' WHERE id = $1`, [revokedCase.certificateId]);
    await processNextSigningJob();
    expect(await jobRow(revokedCase.batch.id)).toMatchObject({ status: 'failed', error_code: 'CERTIFICATE_NOT_USABLE' });
    const res = await getBatch(revokedCase.user.cookie, revokedCase.batch.id);
    expect(res.body.batch.status).toBe('failed');
    expect(res.body.batch.jobs[0].error.message).toContain('ใช้ลงนามไม่ได้แล้ว');

    const closedCase = await submitted();
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [closedCase.user.id]);
    await processNextSigningJob();
    expect(await jobRow(closedCase.batch.id)).toMatchObject({ status: 'failed', error_code: 'ACCOUNT_NOT_ALLOWED' });

    expect(engine).not.toHaveBeenCalled();
    expect(await signAuditLogs(revokedCase.certificateId)).toEqual([]);
  });

  it('TSA ล่ม → คืนเข้าคิวรอลองใหม่ ครบ 3 ครั้งแล้วล้มเหลว TSA_UNAVAILABLE (ไม่ออกไฟล์ที่ไม่มีเวลา)', async () => {
    useFakeSigning(async () => {
      throw new TimestampError('TSA ล่ม');
    });
    const { batch } = await submitted();
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await processNextSigningJob();
      const row = await jobRow(batch.id);
      expect(row).toMatchObject({ status: 'pending', error_code: 'TSA_UNAVAILABLE', attempts: attempt });
      expect(row.run_after.getTime()).toBeGreaterThan(Date.now());
      // ยังไม่ถึงเวลาลองใหม่ = worker ไม่หยิบ
      expect(await processNextSigningJob()).toBe(false);
      await pool.query('UPDATE signing_jobs SET run_after = now() WHERE batch_id = $1', [batch.id]);
    }
    await processNextSigningJob();
    expect(await jobRow(batch.id)).toMatchObject({ status: 'failed', error_code: 'TSA_UNAVAILABLE', attempts: MAX_ATTEMPTS });
    expect((await pool.query(`SELECT count(*)::int AS n FROM files WHERE purpose = 'signing_result'`)).rows[0].n).toBe(0);
    expect([...memory.objects.keys()].some((k) => k.startsWith('signing-result/'))).toBe(false);
  });

  it('ไฟล์ไม่ใช่ PDF / มีลายมือชื่ออยู่แล้ว → ล้มเหลวทันที (ไม่ลองใหม่)', async () => {
    useFakeSigning();
    const notPdf = await submitted({ pdf: Buffer.from('not a pdf at all') });
    await processNextSigningJob();
    expect(await jobRow(notPdf.batch.id)).toMatchObject({ status: 'failed', error_code: 'NOT_PDF', attempts: 1 });

    const first = await signPdf(await samplePdf(), {
      certificate: { serialNumber: '1', certificatePem: 'x', escrow: { kekId: 't', encryptedKey: Buffer.alloc(1), wrappedDataKey: Buffer.alloc(1) } },
      signerName: 'ผู้อื่น',
      lock: false,
      tsaTransport: fake.fakeTsa,
    });
    const already = await submitted({ pdf: first.pdf });
    await processNextSigningJob();
    expect(await jobRow(already.batch.id)).toMatchObject({ status: 'failed', error_code: 'ALREADY_SIGNED' });
  });

  it('งานค้าง signing นานเกิน (worker ตาย) → คืนเข้าคิว / ลองครบแล้ว → ล้มเหลว TIMEOUT และปิดชุด', async () => {
    const { user, batch } = await submitted();
    const claimed = await claimNextSigningJob(pool);
    expect(claimed).not.toBeNull();
    await pool.query(`UPDATE signing_jobs SET started_at = now() - interval '11 minutes' WHERE id = $1`, [claimed!.id]);
    expect(await requeueStaleJobs()).toBe(1);
    expect(await jobRow(batch.id)).toMatchObject({ status: 'pending', attempts: 1 });

    await pool.query(
      `UPDATE signing_jobs SET status = 'signing', attempts = $2, started_at = now() - interval '11 minutes' WHERE id = $1`,
      [claimed!.id, MAX_ATTEMPTS],
    );
    await requeueStaleJobs();
    expect(await jobRow(batch.id)).toMatchObject({ status: 'failed', error_code: 'TIMEOUT' });
    expect((await getBatch(user.cookie, batch.id)).body.batch.status).toBe('failed');
  });

  it('worker หลายตัวหยิบพร้อมกันได้งานคนละงาน (FOR UPDATE SKIP LOCKED)', async () => {
    await submitted();
    await submitted();
    const [a, b, c] = await Promise.all([claimNextSigningJob(pool), claimNextSigningJob(pool), claimNextSigningJob(pool)]);
    const ids = [a, b, c].filter((x) => x !== null).map((x) => x!.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('ชุดเลย 7 วันแล้ว → ไม่ส่ง id ไฟล์ให้ดาวน์โหลด (เหลือแค่ประวัติ)', async () => {
    useFakeSigning();
    const { user, batch } = await submitted();
    await processNextSigningJob();
    await pool.query(`UPDATE signing_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [batch.id]);
    expect((await getBatch(user.cookie, batch.id)).body.batch.jobs[0]).toMatchObject({ status: 'signed', signedFileId: null });
    expect((await request(app).get('/me/signing-batches').set('Cookie', user.cookie)).body.batches[0].firstSignedFileId).toBeNull();
  });
});

describe('ลบบัญชี (PDPA)', () => {
  it('ล้างชื่อไฟล์ในงานลงนาม + ไฟล์หมดอายุทันที / งานที่ยังรอคิว worker ตั้งล้มเหลว ACCOUNT_NOT_ALLOWED', async () => {
    const { user, batch } = await submitted();
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const { rows } = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [user.id]);
    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', await loginAs(admin.id))
      .set('Origin', ORIGIN)
      .send({ confirmEmail: rows[0]!.email, reason: 'คำขอลบข้อมูลผ่าน DPO' });
    expect(res.status).toBe(204);

    const job = await pool.query('SELECT original_name FROM signing_jobs WHERE batch_id = $1', [batch.id]);
    expect(job.rows[0].original_name).toBe('deleted');
    const files = await pool.query('SELECT original_name, expires_at <= now() AS expired FROM files WHERE uploaded_by = $1', [user.id]);
    expect(files.rows).toEqual([{ original_name: 'deleted', expired: true }]);

    await processNextSigningJob();
    expect(await jobRow(batch.id)).toMatchObject({ status: 'failed', error_code: 'ACCOUNT_NOT_ALLOWED' });
  });
});

describe('signedFileName', () => {
  it('ตัด .pdf (ไม่สนตัวพิมพ์) แล้วต่อ -signed.pdf ไม่เกิน 255 ตัวอักษร', () => {
    expect(signedFileName('a.PDF')).toBe('a-signed.pdf');
    expect(signedFileName('report')).toBe('report-signed.pdf');
    expect(signedFileName(`${'ก'.repeat(255)}.pdf`).length).toBeLessThanOrEqual(255);
  });
});
