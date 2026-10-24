import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { supportsCmsCades } from '../src/services/openssl.js';

// ลงนาม CMS ด้วย key สำรอง (ใช้ฝังในลายมือชื่อ PDF) — OpenSSL จริงกับ CA ปลอม แล้วตรวจผลด้วย OpenSSL อีกที

const app = createApp();
const TOKEN = process.env.SIGNER_TOKEN!;
const DAY = 86_400_000;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'msumyid-signer-cms-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type Issued = {
  certificatePem: string;
  serialNumber: string;
  escrow: { kekId: string; encryptedKey: string; wrappedDataKey: string };
};

async function issue(body: object = {}): Promise<Issued> {
  const res = await request(app)
    .post('/certificates')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({ commonName: 'ผู้ลงนาม ทดสอบ', email: 'signer@msu.ac.th', p12Password: 'p12-Password!', ...body });
  expect(res.status).toBe(201);
  return res.body as Issued;
}

const sign = (issued: Issued, content: Buffer, overrides: object = {}) =>
  request(app)
    .post('/signatures/cms')
    .set('Authorization', `Bearer ${TOKEN}`)
    .send({
      serialNumber: issued.serialNumber,
      certificatePem: issued.certificatePem,
      escrow: issued.escrow,
      content: content.toString('base64'),
      ...overrides,
    });

async function tempFile(name: string, data: string | Buffer): Promise<string> {
  const file = path.join(workDir, `${crypto.randomUUID()}-${name}`);
  await writeFile(file, data);
  return file;
}

/** ตรวจ CMS แบบ detached กับข้อมูลเดิม และต่อสายถึง root ของ CA ปลอม */
async function verifyCms(cmsBase64: string, content: Buffer) {
  const cmsFile = await tempFile('sig.der', Buffer.from(cmsBase64, 'base64'));
  const contentFile = await tempFile('content.bin', content);
  const result = spawnSync(
    'openssl',
    ['cms', '-verify', '-binary', '-inform', 'DER', '-in', cmsFile, '-content', contentFile, '-CAfile', config.ca.chainPath!, '-purpose', 'any', '-out', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    { encoding: 'utf8' },
  );
  const printed = spawnSync('openssl', ['cms', '-cmsout', '-inform', 'DER', '-in', cmsFile, '-print', '-noout'], { encoding: 'utf8' });
  return { ok: result.status === 0, detail: result.stderr, structure: printed.stdout };
}

describe('POST /signatures/cms', () => {
  it('ไม่มี token → 401', async () => {
    expect((await request(app).post('/signatures/cms').send({})).status).toBe(401);
  });

  it('ลงนามด้วย key สำรองของใบนั้น: ตรวจกับข้อมูลเดิมผ่าน, เป็น detached + CAdES (signingCertificateV2) และแนบใบของ CA', async () => {
    const issued = await issue({ profile: 'document_signing', notBefore: new Date().toISOString(), notAfter: new Date(Date.now() + 7 * DAY).toISOString() });
    const content = Buffer.from('%PDF-1.7 ข้อมูลตาม ByteRange');
    const res = await sign(issued, content);
    expect(res.status).toBe(200);

    const { ok, detail, structure } = await verifyCms(res.body.cms, content);
    expect(ok, detail).toBe(true);
    // runner ของ GitHub ใช้ OpenSSL 3.0 ที่ยังไม่มี -cades (production 3.5 มี)
    if (await supportsCmsCades(config.opensslBin)) expect(structure).toContain('id-smime-aa-signingCertificateV2');
    expect(structure).toContain('messageDigest');
    // detached: ไม่มีเนื้อหาอยู่ใน CMS
    expect(structure).toMatch(/eContent: <ABSENT>/);
    // ใบของผู้ลงนาม + Intermediate + root
    expect(structure.match(/subject:/g)?.length).toBeGreaterThanOrEqual(3);

    // ข้อมูลถูกแก้ → ตรวจไม่ผ่าน
    expect((await verifyCms(res.body.cms, Buffer.from('%PDF-1.7 ข้อมูลที่ถูกแก้'))).ok).toBe(false);
  });

  it('ใบประจำตัว (S/MIME) ก็ลงนามได้', async () => {
    const issued = await issue();
    const content = Buffer.from('content');
    const res = await sign(issued, content);
    expect(res.status).toBe(200);
    expect((await verifyCms(res.body.cms, content)).ok).toBe(true);
  });

  it('ใบยังไม่ถึงวันเริ่ม → 422 CERTIFICATE_NOT_VALID_NOW', async () => {
    const issued = await issue({
      profile: 'document_signing',
      notBefore: new Date(Date.now() + 3 * DAY).toISOString(),
      notAfter: new Date(Date.now() + 5 * DAY).toISOString(),
    });
    const res = await sign(issued, Buffer.from('x'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CERTIFICATE_NOT_VALID_NOW');
  });

  it('key สำรองของอีกใบ → 422 ESCROW_INVALID / serial ไม่ตรง → 422 SERIAL_MISMATCH / ข้อมูลว่าง → 400', async () => {
    const a = await issue();
    const b = await issue();
    expect((await sign(a, Buffer.from('x'), { escrow: b.escrow })).body.error.code).toBe('ESCROW_INVALID');
    expect((await sign(a, Buffer.from('x'), { serialNumber: b.serialNumber })).body.error.code).toBe('SERIAL_MISMATCH');
    expect((await sign(a, Buffer.alloc(0))).status).toBe(400);
  });
});
