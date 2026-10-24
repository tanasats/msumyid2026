import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { cleanupExpiredFiles } from '../src/services/file-service.js';
import { storage, StorageError } from '../src/storage/index.js';
import { createTestRole, createUser, loginAs, resetDatabase } from './helpers/db.js';
import { useMemoryStorage } from './helpers/storage.js';

// ไฟล์ใน storage: ขอ URL อัปโหลด → ยืนยัน → ดาวน์โหลด → ลบเมื่อหมดอายุ (document:sign)
// storage จำลองในหน่วยความจำ ฐานข้อมูลใช้ app_test จริง

const app = createApp();
const ORIGIN = 'http://localhost:3010';
const MB = 1024 * 1024;

let memory: ReturnType<typeof useMemoryStorage>;

beforeEach(async () => {
  await resetDatabase();
  memory = useMemoryStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

async function signer() {
  await createTestRole('test_sign', ['document:sign']).catch(() => {});
  const user = await createUser({ roles: ['user', 'staff', 'test_sign'] });
  return { ...user, cookie: await loginAs(user.id) };
}

const post = (cookie: string, path: string, body: object = {}) =>
  request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);

const pdfUpload = (cookie: string, body: object = {}) =>
  post(cookie, '/me/files', { purpose: 'signing_source', originalName: 'คำสั่ง ที่ 1-2569.pdf', mimeType: 'application/pdf', size: 8, ...body });

describe('ขอ URL อัปโหลด', () => {
  it('ไม่มี document:sign → 403 / มี → แถว pending + URL ที่เซ็นชนิดไฟล์ + object key เป็น UUID (ไม่ใช้ชื่อไฟล์) หมดอายุ 7 วัน', async () => {
    const none = await createUser();
    expect((await pdfUpload(await loginAs(none.id))).status).toBe(403);

    const user = await signer();
    const res = await pdfUpload(user.cookie);
    expect(res.status).toBe(201);
    expect(res.body.file).toMatchObject({ status: 'pending', originalName: 'คำสั่ง ที่ 1-2569.pdf', size: 8 });
    expect(res.body.uploadUrl).toMatch(/^memory:\/\/upload\/signing-source\/[0-9a-f-]{36}\?type=application\/pdf$/);
    const days = (Date.parse(res.body.file.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    const { rows } = await pool.query('SELECT object_key, uploaded_by FROM files WHERE id = $1', [res.body.file.id]);
    expect(rows[0]).toMatchObject({ uploaded_by: user.id });
    expect(rows[0].object_key).not.toContain('คำสั่ง');
  });

  it('ชนิดไม่อยู่ใน allowlist / ใหญ่เกิน / ขนาด 0 → 422 ไม่สร้างแถว / purpose ที่ระบบสร้างเอง → 400', async () => {
    const user = await signer();
    expect((await pdfUpload(user.cookie, { mimeType: 'text/html' })).body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    expect((await pdfUpload(user.cookie, { size: 20 * MB + 1 })).body.error.code).toBe('FILE_TOO_LARGE');
    expect((await pdfUpload(user.cookie, { mimeType: 'application/zip', size: 500 * MB })).status).toBe(201);
    expect((await pdfUpload(user.cookie, { purpose: 'signature_image', mimeType: 'image/png', size: 2 * MB })).body.error.code).toBe(
      'FILE_TOO_LARGE',
    );
    expect((await pdfUpload(user.cookie, { size: 0 })).status).toBe(400);
    expect((await pdfUpload(user.cookie, { purpose: 'signing_result' })).status).toBe(400);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM files');
    expect(rows[0].n).toBe(1);
  });

  it('ไม่ส่ง Origin → 403 (CSRF)', async () => {
    const user = await signer();
    const res = await request(app).post('/me/files').set('Cookie', user.cookie).send({});
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('storage ล่ม → 503 STORAGE_UNAVAILABLE', async () => {
    vi.spyOn(storage, 'presignUpload').mockRejectedValueOnce(new StorageError('ล่ม'));
    const user = await signer();
    expect((await pdfUpload(user.cookie)).body.error.code).toBe('STORAGE_UNAVAILABLE');
  });
});

describe('ยืนยันการอัปโหลด / ดาวน์โหลด', () => {
  it('ยังไม่อัปโหลด → 409 / ขนาดหรือชนิดไม่ตรง → 422 และไฟล์ถูกตั้งให้หมดอายุ / ตรง → uploaded แล้วดาวน์โหลดได้ด้วยชื่อเดิม', async () => {
    const user = await signer();
    const { body } = await pdfUpload(user.cookie);
    const complete = () => post(user.cookie, `/me/files/${body.file.id}/complete`);
    expect((await complete()).body.error.code).toBe('UPLOAD_NOT_FOUND');

    const bad = await pdfUpload(user.cookie);
    memory.upload(bad.body.uploadUrl, Buffer.from('%PDF-1.4 + more bytes'), 'application/pdf');
    expect((await post(user.cookie, `/me/files/${bad.body.file.id}/complete`)).body.error.code).toBe('UPLOAD_MISMATCH');
    const { rows } = await pool.query('SELECT expires_at <= now() AS expired FROM files WHERE id = $1', [bad.body.file.id]);
    expect(rows[0].expired).toBe(true);

    memory.upload(body.uploadUrl, Buffer.from('%PDF-1.4'), 'application/pdf');
    expect((await complete()).body.file.status).toBe('uploaded');
    // ยืนยันซ้ำได้ (idempotent)
    expect((await complete()).status).toBe(200);

    const download = await request(app).get(`/me/files/${body.file.id}/download`).set('Cookie', user.cookie);
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toBe('no-store');
    expect(decodeURIComponent(download.body.url)).toContain('name=คำสั่ง ที่ 1-2569.pdf');
  });

  it('ไฟล์ของคนอื่น → 404 / ยังไม่ยืนยัน → ดาวน์โหลดไม่ได้ (409)', async () => {
    const owner = await signer();
    const other = await signer();
    const { body } = await pdfUpload(owner.cookie);
    expect((await post(other.cookie, `/me/files/${body.file.id}/complete`)).status).toBe(404);
    expect((await request(app).get(`/me/files/${body.file.id}/download`).set('Cookie', other.cookie)).status).toBe(404);
    expect((await request(app).get(`/me/files/${body.file.id}/download`).set('Cookie', owner.cookie)).body.error.code).toBe(
      'FILE_NOT_READY',
    );
  });
});

describe('ลบไฟล์หมดอายุ', () => {
  it('ลบ object ใน storage แล้วตั้ง deleted_at — ไฟล์ที่ยังไม่หมดอายุไม่ถูกแตะ / ลบแล้วดาวน์โหลดไม่ได้', async () => {
    const user = await signer();
    const expired = await pdfUpload(user.cookie);
    const kept = await pdfUpload(user.cookie);
    const expiredKey = memory.upload(expired.body.uploadUrl, Buffer.from('%PDF-1.4'), 'application/pdf');
    const keptKey = memory.upload(kept.body.uploadUrl, Buffer.from('%PDF-1.4'), 'application/pdf');
    await pool.query("UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = $1", [expired.body.file.id]);

    expect(await cleanupExpiredFiles()).toBe(1);
    expect(memory.objects.has(expiredKey)).toBe(false);
    expect(memory.objects.has(keptKey)).toBe(true);
    const { rows } = await pool.query('SELECT id, deleted_at IS NOT NULL AS deleted FROM files ORDER BY created_at');
    expect(rows.map((r) => r.deleted)).toEqual([true, false]);
    expect((await post(user.cookie, `/me/files/${expired.body.file.id}/complete`)).status).toBe(404);
    // รอบถัดไปไม่มีอะไรให้ลบ
    expect(await cleanupExpiredFiles()).toBe(0);
  });

  it('storage ล่มระหว่างลบ → แถวยังไม่ถูกตั้ง deleted_at (รอบถัดไปลองใหม่)', async () => {
    const user = await signer();
    const { body } = await pdfUpload(user.cookie);
    await pool.query("UPDATE files SET expires_at = now() - interval '1 minute' WHERE id = $1", [body.file.id]);
    vi.spyOn(storage, 'remove').mockRejectedValueOnce(new StorageError('ล่ม'));
    await expect(cleanupExpiredFiles()).rejects.toBeInstanceOf(StorageError);
    const { rows } = await pool.query('SELECT deleted_at FROM files WHERE id = $1', [body.file.id]);
    expect(rows[0].deleted_at).toBeNull();
  });

  it('ลบบัญชี (PDPA) → ไฟล์ของผู้ใช้ถูกล้างชื่อและหมดอายุทันที แล้ว job ลบ object', async () => {
    const user = await signer();
    const { body } = await pdfUpload(user.cookie);
    const key = memory.upload(body.uploadUrl, Buffer.from('%PDF-1.4'), 'application/pdf');
    await post(user.cookie, `/me/files/${body.file.id}/complete`);

    const email = (await pool.query('SELECT email FROM users WHERE id = $1', [user.id])).rows[0].email;
    vi.spyOn((await import('../src/services/signer-client.js')).signer, 'generateCrl').mockResolvedValue(Buffer.from('crl'));
    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const res = await request(app)
      .delete(`/admin/users/${user.id}`)
      .set('Cookie', await loginAs(admin.id))
      .set('Origin', ORIGIN)
      .send({ confirmEmail: email, reason: 'ขอลบข้อมูล' });
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT original_name, expires_at <= now() AS expired FROM files WHERE id = $1', [body.file.id]);
    expect(rows[0]).toEqual({ original_name: 'deleted', expired: true });
    await cleanupExpiredFiles();
    expect(memory.objects.has(key)).toBe(false);
  });
});
