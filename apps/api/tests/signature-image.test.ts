import { randomBytes } from 'node:crypto';
import { PDFArray, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { signPdf } from '../src/services/pdf-signing/index.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { processNextSigningJob, signingEngine } from '../src/services/signing-worker-service.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import { createFakeSigning } from './helpers/fake-signing.js';
import { solidPng } from './helpers/png.js';
import { useMemoryStorage } from './helpers/storage.js';

// ภาพลายเซ็นและลายมือชื่อแบบมองเห็น (ระยะ D2): ตั้ง/เปลี่ยน/ลบภาพ, ส่งตำแหน่งกับคำขอลงนาม, worker วางภาพ/ข้อความ

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

const send = (method: 'post' | 'put' | 'delete', cookie: string, path: string, body: object = {}) =>
  request(app)[method](path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

async function signerUser() {
  await createTestRole('test_sign', ['document:sign']).catch(() => {});
  const user = await createUser({ name: 'สมชาย ลงนาม', roles: ['user', 'staff', 'test_sign'] });
  const cookie = await loginAs(user.id);
  expect((await send('put', cookie, '/me/signing-pin', { newPin: PIN })).status).toBe(200);
  return { ...user, cookie };
}

async function upload(cookie: string, body: Buffer, purpose: 'signature_image' | 'signing_source', mimeType: string) {
  const created = await send('post', cookie, '/me/files', { purpose, originalName: 'x', mimeType, size: body.length });
  expect(created.status).toBe(201);
  memory.upload(created.body.uploadUrl, body, mimeType);
  expect((await send('post', cookie, `/me/files/${created.body.file.id}/complete`)).status).toBe(200);
  return created.body.file.id as string;
}

const setImage = async (cookie: string, png: Buffer) =>
  send('put', cookie, '/me/signature-image', { fileId: await upload(cookie, png, 'signature_image', 'image/png') });

const fileRow = async (id: string) =>
  (await pool.query('SELECT expires_at, deleted_at FROM files WHERE id = $1', [id])).rows[0] as { expires_at: Date | null; deleted_at: Date | null };

describe('ภาพลายเซ็น', () => {
  it('ไม่มี document:sign → 403 / ยังไม่ตั้ง → null / ตั้งแล้วได้ขนาดภาพ + URL และไฟล์ไม่หมดอายุ', async () => {
    const none = await createUser();
    expect((await request(app).get('/me/signature-image').set('Cookie', await loginAs(none.id))).status).toBe(403);

    const user = await signerUser();
    expect((await request(app).get('/me/signature-image').set('Cookie', user.cookie)).body).toEqual({ image: null });
    const res = await setImage(user.cookie, solidPng(300, 120));
    expect(res.status).toBe(200);
    expect(res.body.image).toMatchObject({ width: 300, height: 120 });
    expect(res.body.image.url).toMatch(/^memory:\/\/download\/signature-image\//);
    expect((await fileRow(res.body.image.fileId)).expires_at).toBeNull();
  });

  it('เปลี่ยนภาพ → ไฟล์เดิมหมดอายุทันที / ลบภาพ → 204 และไฟล์หมดอายุ', async () => {
    const user = await signerUser();
    const first = (await setImage(user.cookie, solidPng(100, 40))).body.image.fileId;
    const second = (await setImage(user.cookie, solidPng(200, 80))).body.image;
    expect(second).toMatchObject({ width: 200, height: 80 });
    expect((await fileRow(first)).expires_at!.getTime()).toBeLessThanOrEqual(Date.now());

    expect((await send('delete', user.cookie, '/me/signature-image')).status).toBe(204);
    expect((await request(app).get('/me/signature-image').set('Cookie', user.cookie)).body.image).toBeNull();
    expect((await fileRow(second.fileId)).expires_at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('ไม่ใช่ PNG / เล็กหรือใหญ่เกิน → 422 และไฟล์นั้นหมดอายุ / ไฟล์ของคนอื่น → 404', async () => {
    const user = await signerUser();
    const fake = Buffer.concat([Buffer.from('not a png'), randomBytes(40)]);
    const notPng = await upload(user.cookie, fake, 'signature_image', 'image/png');
    const res = await send('put', user.cookie, '/me/signature-image', { fileId: notPng });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SIGNATURE_IMAGE_INVALID');
    expect((await fileRow(notPng)).expires_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await setImage(user.cookie, solidPng(10, 10))).body.error.code).toBe('SIGNATURE_IMAGE_INVALID');
    expect((await setImage(user.cookie, solidPng(2100, 20))).body.error.code).toBe('SIGNATURE_IMAGE_INVALID');

    const other = await signerUser();
    const othersImage = await upload(other.cookie, solidPng(100, 40), 'signature_image', 'image/png');
    expect((await send('put', user.cookie, '/me/signature-image', { fileId: othersImage })).status).toBe(404);
  });
});

describe('ลบบัญชี (PDPA)', () => {
  it('ลบแถวภาพลายเซ็น และไฟล์ภาพหมดอายุทันที', async () => {
    const user = await signerUser();
    const image = (await setImage(user.cookie, solidPng(300, 120))).body.image;
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const { rows } = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [user.id]);
    const res = await send('delete', await loginAs(admin.id), `/admin/users/${user.id}`, { confirmEmail: rows[0]!.email, reason: 'คำขอลบข้อมูล' });
    expect(res.status).toBe(204);
    expect((await pool.query('SELECT 1 FROM signature_images WHERE user_id = $1', [user.id])).rows).toHaveLength(0);
    expect((await fileRow(image.fileId)).expires_at!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('ลงนามแบบมองเห็น', () => {
  async function insertCertificate(userId: string) {
    const notAfter = new Date(Date.now() + 365 * DAY);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after, source, certificate_pem, fingerprint_sha256)
       VALUES ($1, $2, 'สมชาย ลงนาม', 'somchai@msu.ac.th', $3, $4, 'issued', 'PEM', $5)
       RETURNING id`,
      [userId, `1${randomBytes(15).toString('hex')}`, new Date(notAfter.getTime() - 365 * DAY), notAfter, randomBytes(32).toString('hex')],
    );
    await pool.query(
      `INSERT INTO certificate_key_escrows (certificate_id, encrypted_key, wrapped_data_key, kek_id) VALUES ($1, $2, $3, 'test-1')`,
      [rows[0]!.id, randomBytes(40), randomBytes(60)],
    );
    return rows[0]!.id;
  }

  async function samplePdf(pages = 1): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) doc.addPage([600, 800]).drawText(`Page ${i + 1}`, { x: 50, y: 750, font, size: 14 });
    return Buffer.from(await doc.save());
  }

  const box = { visible: true, page: 1, x: 0.6, y: 0.8, w: 0.3, h: 0.12, showText: true, useImage: true };

  async function prepare(pages = 1) {
    const user = await signerUser();
    const certificateId = await insertCertificate(user.id);
    const fileId = await upload(user.cookie, await samplePdf(pages), 'signing_source', 'application/pdf');
    return { user, certificateId, fileId };
  }

  const submit = (cookie: string, body: object) => send('post', cookie, '/me/signing-batches', { lockDocument: false, pin: PIN, ...body });

  function useFakeSigning() {
    fake.mockSigner();
    vi.spyOn(signingEngine, 'signPdf').mockImplementation((pdf, options) => signPdf(pdf, { ...options, tsaTransport: fake.fakeTsa }));
    // LTV ทดสอบแยกใน ltv.test.ts / signing.test.ts — ที่นี่ปิดไว้ ไฟล์ผลลัพธ์จึงครอบคลุมทั้งไฟล์เหมือนเดิม
    vi.spyOn(signingEngine, 'collectRevocationMaterial').mockResolvedValue({ material: null, reason: 'ปิดใน test' });
  }

  async function signedPdfOf(batchId: string): Promise<Buffer> {
    const { rows } = await pool.query(
      `SELECT f.object_key FROM signing_jobs j JOIN files f ON f.id = j.signed_file_id WHERE j.batch_id = $1`,
      [batchId],
    );
    return memory.objects.get(rows[0].object_key)!.body;
  }

  it('ใช้ภาพ + ข้อความ: บันทึก file_id ของภาพไว้ในชุด → worker วางลายเซ็นบนหน้าที่เลือก ลายมือชื่อตรวจผ่าน', async () => {
    useFakeSigning();
    const { user, certificateId, fileId } = await prepare(2);
    const image = (await setImage(user.cookie, solidPng(300, 120))).body.image;
    const res = await submit(user.cookie, { fileId, certificateId, appearance: { ...box, page: 2 } });
    expect(res.status).toBe(202);
    const stored = await pool.query('SELECT appearance FROM signing_batches WHERE id = $1', [res.body.batch.id]);
    expect(stored.rows[0].appearance).toEqual({ visible: true, page: 2, x: 0.6, y: 0.8, w: 0.3, h: 0.12, showText: true, imageFileId: image.fileId });

    await processNextSigningJob();
    const pdf = await signedPdfOf(res.body.batch.id);
    expect((await verifyPdfSignatures(pdf)).signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });
    const doc = await PDFDocument.load(pdf);
    const annots = doc.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
  });

  it('ไม่ส่ง appearance = มองไม่เห็น (แบบ D1) / ใช้ภาพแต่ยังไม่ตั้ง → 409 / ไม่มีทั้งภาพและข้อความ → 422 / กล่องล้นหน้า → 400', async () => {
    const { user, certificateId, fileId } = await prepare();
    const invisible = await submit(user.cookie, { fileId, certificateId });
    expect(invisible.status).toBe(202);
    const stored = await pool.query('SELECT appearance FROM signing_batches WHERE id = $1', [invisible.body.batch.id]);
    expect(stored.rows[0].appearance).toEqual({ visible: false });

    expect((await submit(user.cookie, { fileId, certificateId, appearance: box })).body.error.code).toBe('SIGNATURE_IMAGE_NOT_SET');
    expect((await submit(user.cookie, { fileId, certificateId, appearance: { ...box, useImage: false, showText: false } })).body.error.code).toBe(
      'APPEARANCE_EMPTY',
    );
    expect((await submit(user.cookie, { fileId, certificateId, appearance: { ...box, x: 0.8 } })).status).toBe(400);
    expect((await submit(user.cookie, { fileId, certificateId, appearance: { ...box, w: 0.01 } })).status).toBe(400);
  });

  it('ข้อความอย่างเดียว (ยังไม่ตั้งภาพ) ลงนามได้ / หน้าที่เลือกไม่มีในไฟล์ → ล้มเหลว PAGE_NOT_FOUND', async () => {
    useFakeSigning();
    const { user, certificateId, fileId } = await prepare();
    const textOnly = await submit(user.cookie, { fileId, certificateId, appearance: { ...box, useImage: false } });
    await processNextSigningJob();
    expect((await request(app).get(`/me/signing-batches/${textOnly.body.batch.id}`).set('Cookie', user.cookie)).body.batch.status).toBe(
      'completed',
    );

    const missingPage = await submit(user.cookie, { fileId, certificateId, appearance: { ...box, useImage: false, page: 5 } });
    await processNextSigningJob();
    const res = await request(app).get(`/me/signing-batches/${missingPage.body.batch.id}`).set('Cookie', user.cookie);
    expect(res.body.batch.jobs[0].error).toMatchObject({ code: 'PAGE_NOT_FOUND' });
  });

  it('ภาพที่เลือกถูกลบก่อน worker ลงนาม → ล้มเหลว SIGNATURE_IMAGE_MISSING (ไม่ลงนามโดยไม่มีภาพ)', async () => {
    useFakeSigning();
    const { user, certificateId, fileId } = await prepare();
    const image = (await setImage(user.cookie, solidPng(300, 120))).body.image;
    const res = await submit(user.cookie, { fileId, certificateId, appearance: box });
    await pool.query('UPDATE files SET deleted_at = now() WHERE id = $1', [image.fileId]);
    await processNextSigningJob();
    const job = await pool.query('SELECT status, error_code FROM signing_jobs WHERE batch_id = $1', [res.body.batch.id]);
    expect(job.rows[0]).toEqual({ status: 'failed', error_code: 'SIGNATURE_IMAGE_MISSING' });
  });
});
