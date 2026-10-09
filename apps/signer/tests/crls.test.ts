import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';

// ออก CRL กับ CA ปลอมและ OpenSSL จริง แล้วตรวจด้วย openssl crl (ลายเซ็น, เลข CRL, วันที่, รายการเพิกถอน)

const app = createApp();
const TOKEN = process.env.SIGNER_TOKEN!;
const HOUR = 60 * 60 * 1000;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'msumyid-crl-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function generate(body: object) {
  return request(app).post('/crls').set('Authorization', `Bearer ${TOKEN}`).send(body);
}

/** แปลง CRL (DER base64) เป็นข้อความ และตรวจลายเซ็นกับใบของ CA */
async function inspect(crlDerBase64: string) {
  const file = path.join(workDir, `${crypto.randomUUID()}.crl`);
  await writeFile(file, Buffer.from(crlDerBase64, 'base64'));
  const result = spawnSync(
    'openssl',
    ['crl', '-inform', 'DER', '-in', file, '-CAfile', config.ca.certPath, '-noout', '-text'],
    { encoding: 'utf8' },
  );
  return { ok: result.status === 0, text: result.stdout, verify: result.stderr };
}

const thisUpdate = new Date('2026-10-08T03:00:00Z');
const nextUpdate = new Date(thisUpdate.getTime() + 7 * 24 * HOUR);

describe('POST /crls', () => {
  it('ไม่มี token → 401', async () => {
    const res = await request(app).post('/crls').send({});
    expect(res.status).toBe(401);
  });

  it('CRL ว่าง (ยังไม่มีใบถูกเพิกถอน) — CA เซ็นถูกต้อง มีเลข CRL และวันที่ตามที่ส่ง', async () => {
    const res = await generate({
      crlNumber: '1791449000',
      thisUpdate: thisUpdate.toISOString(),
      nextUpdate: nextUpdate.toISOString(),
      revoked: [],
    });
    expect(res.status).toBe(201);

    const crl = await inspect(res.body.crlDer);
    expect(crl.ok).toBe(true);
    expect(crl.verify).toContain('verify OK');
    expect(crl.text).toContain('Issuer: C=TH, O=Mahasarakham University, CN=MSU Digital ID DEV Intermediate CA');
    expect(crl.text).toMatch(/Last Update: Oct\s+8 03:00:00 2026 GMT/);
    expect(crl.text).toMatch(/Next Update: Oct\s+15 03:00:00 2026 GMT/);
    // openssl crl -text แสดงเลข CRL เป็นฐาน 10
    expect(crl.text).toMatch(/X509v3 CRL Number:\s*\n\s*1791449000\s*\n/);
    expect(crl.text).toContain('X509v3 Authority Key Identifier');
    expect(crl.text).toContain('No Revoked Certificates');
  });

  it('รายการเพิกถอนครบ พร้อม serial วันที่ และเหตุผล', async () => {
    const res = await generate({
      crlNumber: '1791449001',
      thisUpdate: thisUpdate.toISOString(),
      nextUpdate: nextUpdate.toISOString(),
      revoked: [
        {
          serialNumber: '35fcef5d709168902df8e43268a8d8d1',
          revokedAt: '2026-10-07T10:20:30Z',
          reason: 'keyCompromise',
          notAfter: '2027-10-07T00:00:00Z',
        },
        // serial ความยาวคี่ และหมดอายุหลังปี 2050 (GeneralizedTime ใน index.txt)
        { serialNumber: 'abc', revokedAt: '2026-10-06T00:00:00Z', reason: 'superseded', notAfter: '2051-01-01T00:00:00Z' },
        { serialNumber: '1000', revokedAt: '2026-10-05T00:00:00Z', reason: 'unspecified', notAfter: '2027-01-01T00:00:00Z' },
      ],
    });
    expect(res.status).toBe(201);

    const crl = await inspect(res.body.crlDer);
    expect(crl.verify).toContain('verify OK');
    expect(crl.text).toMatch(/Serial Number: 35FCEF5D709168902DF8E43268A8D8D1\s*\n\s*Revocation Date: Oct\s+7 10:20:30 2026 GMT[\s\S]*?Key Compromise/);
    expect(crl.text).toMatch(/Serial Number: 0ABC\s*\n\s*Revocation Date: Oct\s+6 00:00:00 2026 GMT[\s\S]*?Superseded/);
    expect(crl.text).toMatch(/Serial Number: 1000\s*\n\s*Revocation Date: Oct\s+5 00:00:00 2026 GMT/);
  });

  it.each([
    ['nextUpdate ไม่อยู่หลัง thisUpdate', { nextUpdate: thisUpdate.toISOString() }],
    ['เลข CRL ไม่ใช่ตัวเลข', { crlNumber: 'abc' }],
    ['เหตุผลที่ไม่รองรับ', { revoked: [{ serialNumber: 'a1', revokedAt: '2026-10-01T00:00:00Z', reason: 'certificateHold', notAfter: '2027-01-01T00:00:00Z' }] }],
    ['serial ไม่ใช่ฐาน 16 ตัวพิมพ์เล็ก', { revoked: [{ serialNumber: 'XYZ', revokedAt: '2026-10-01T00:00:00Z', reason: 'superseded', notAfter: '2027-01-01T00:00:00Z' }] }],
  ])('%s → 400', async (_label, overrides) => {
    const res = await generate({
      crlNumber: '1',
      thisUpdate: thisUpdate.toISOString(),
      nextUpdate: nextUpdate.toISOString(),
      revoked: [],
      ...overrides,
    });
    expect(res.status).toBe(400);
  });
});
