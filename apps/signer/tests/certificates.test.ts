import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { openPrivateKey } from '../src/services/escrow.js';
import { runOpenssl } from '../src/services/openssl.js';

// ออกใบรับรองกับ CA ปลอมและ OpenSSL จริง (ไม่ mock) แล้วตรวจผลด้วย OpenSSL อีกที

const app = createApp();
const TOKEN = process.env.SIGNER_TOKEN!;
const NAME = 'สมชาย ใจดี';
const EMAIL = 'somchai.j@msu.ac.th';
const PASSWORD = 'p12-Password!';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'msumyid-signer-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

type IssueResponse = {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: string;
  notAfter: string;
  p12: string;
  escrow: { kekId: string; encryptedKey: string; wrappedDataKey: string };
};

function issue(body: object, token = TOKEN) {
  return request(app).post('/certificates').set('Authorization', `Bearer ${token}`).send(body);
}

async function issueOk(overrides: object = {}): Promise<IssueResponse> {
  const res = await issue({ commonName: NAME, email: EMAIL, p12Password: PASSWORD, ...overrides });
  expect(res.status).toBe(201);
  return res.body as IssueResponse;
}

/** เขียนไฟล์ลงโฟลเดอร์ test แล้วคืน path */
async function tempFile(name: string, data: string | Buffer): Promise<string> {
  const file = path.join(workDir, `${crypto.randomUUID()}-${name}`);
  await writeFile(file, data);
  return file;
}

async function certText(pem: string): Promise<string> {
  const file = await tempFile('cert.pem', pem);
  return (await runOpenssl('openssl', ['x509', '-in', file, '-noout', '-text', '-nameopt', 'utf8,sep_comma_plus'])).toString('utf8');
}

/**
 * เปิด .p12 ด้วยรหัสผ่าน (เฉพาะใบรับรอง) — คืน stdout (ใบรับรอง PEM) และ stderr (-info: อัลกอริทึมที่ใช้เข้ารหัส)
 * status ไม่ใช่ 0 = เปิดไม่ได้ (เช่น รหัสผ่านผิด)
 */
async function openP12(p12Base64: string, password: string) {
  const file = await tempFile('cert.p12', Buffer.from(p12Base64, 'base64'));
  const result = spawnSync('openssl', ['pkcs12', '-in', file, '-passin', 'env:P', '-nokeys', '-info'], {
    env: { ...process.env, P: password },
    encoding: 'utf8',
  });
  return { ok: result.status === 0, certificates: result.stdout, info: result.stderr };
}

describe('สิทธิ์ผู้เรียก', () => {
  it('ไม่มี token → 401', async () => {
    const res = await request(app).post('/certificates').send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('token ผิด → 401', async () => {
    const res = await issue({ commonName: NAME, email: EMAIL, p12Password: PASSWORD }, 'wrong-token');
    expect(res.status).toBe(401);
  });

  it('health ไม่ต้องใช้ token และตรวจว่าอ่าน CA ได้', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

/** ใบรับรองมีค่านี้เป็น UTF8String (แท็ก 0x0c + ความยาวแบบ DER + ไบต์ UTF-8) ตรงทุกไบต์ */
function hasUtf8String(pem: string, value: string): boolean {
  const bytes = Buffer.from(value, 'utf8');
  const length = bytes.length < 0x80 ? [bytes.length] : [0x81, bytes.length];
  return new X509Certificate(pem).raw.includes(Buffer.concat([Buffer.from([0x0c, ...length]), bytes]));
}

describe('ออกใบรับรอง', () => {
  it('CA เซ็นจริง และ subject เป็นชื่อไทย (UTF8String) + อีเมล ตาม policy เดิม', async () => {
    const body = await issueOk();
    const cert = new X509Certificate(body.certificatePem);
    const ca = new X509Certificate(await readFile(config.ca.certPath));

    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.subject.split('\n')).toEqual([
      'C=TH',
      'O=Mahasarakham University',
      `CN=${NAME}`,
      `emailAddress=${EMAIL}`,
    ]);

    expect(hasUtf8String(body.certificatePem, NAME)).toBe(true);
  });

  it('extensions ตรงกับ [ smime ] ของระบบเดิมทุกตัว', async () => {
    const body = await issueOk();
    const text = await certText(body.certificatePem);

    expect(text).toMatch(/X509v3 Basic Constraints:\s*\n\s*CA:FALSE/);
    expect(text).toMatch(/X509v3 Key Usage: critical\s*\n\s*Digital Signature, Key Encipherment/);
    expect(text).toMatch(/X509v3 Extended Key Usage:\s*\n\s*E-mail Protection/);
    expect(text).toMatch(new RegExp(`X509v3 Subject Alternative Name:\\s*\\n\\s*email:${EMAIL}`));
    expect(text).toContain('X509v3 Subject Key Identifier');
    expect(text).toContain('X509v3 Authority Key Identifier');
    expect(text).toMatch(/X509v3 CRL Distribution Points:[\s\S]*URI:https:\/\/cdp\.msu\.ac\.th\/msu-ca\.crl/);
    expect(text).toContain('Signature Algorithm: sha256WithRSAEncryption');
  });

  it('อายุตาม CERT_VALIDITY_DAYS และ serial/fingerprint ตรงกับใบรับรอง', async () => {
    const body = await issueOk();
    const cert = new X509Certificate(body.certificatePem);
    const days = (Date.parse(body.notAfter) - Date.parse(body.notBefore)) / 86_400_000;

    expect(days).toBe(config.certValidityDays);
    expect(body.serialNumber).toMatch(/^[1-9a-f][0-9a-f]*$/);
    expect(body.serialNumber).toBe(cert.serialNumber.toLowerCase().replace(/^0+/, ''));
    expect(body.fingerprintSha256).toBe(cert.fingerprint256.replaceAll(':', '').toLowerCase());
  });

  it('serial ไม่ซ้ำกันระหว่างใบ', async () => {
    const [a, b] = await Promise.all([issueOk(), issueOk()]);
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });

  it('ชื่อที่มีอักขระพิเศษของ config / subject อยู่ใน CN ตรงตามที่ส่ง', async () => {
    const name = `ทดสอบ/ระบบ $HOME #1 "a" \\b + c=d`;
    const body = await issueOk({ commonName: name });
    // ตรวจไบต์จริง เพราะ cert.subject ของ Node ใส่ \ หน้าอักขระพิเศษตอนแสดงผล
    expect(hasUtf8String(body.certificatePem, name)).toBe(true);
  });
});

describe('ไฟล์ .p12', () => {
  it('เปิดได้ด้วยรหัสผ่านที่ตั้ง มีใบของผู้ใช้ + Intermediate CA และเข้ารหัสแบบ AES-256 (ค่าเริ่มต้น)', async () => {
    const body = await issueOk();
    const p12 = await openP12(body.p12, PASSWORD);
    expect(p12.ok).toBe(true);
    expect(p12.certificates.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    expect(p12.certificates).toContain('subject=C=TH, O=Mahasarakham University, CN=MSU Digital ID DEV Intermediate CA');
    expect(p12.info).toContain('AES-256-CBC');
    expect(p12.info).not.toContain('TripleDES');
  });

  it('รหัสผ่านผิด → เปิดไม่ได้', async () => {
    const body = await issueOk();
    expect((await openP12(body.p12, 'wrong-password')).ok).toBe(false);
  });

  it('legacyP12 = true → เข้ารหัสแบบ 3DES + MAC SHA-1 ให้โปรแกรมรุ่นเก่าเปิดได้', async () => {
    const body = await issueOk({ legacyP12: true });
    const p12 = await openP12(body.p12, PASSWORD);
    expect(p12.ok).toBe(true);
    expect(p12.info).toContain('pbeWithSHA1And3-KeyTripleDES-CBC');
    expect(p12.info).toMatch(/MAC: sha1/);
    expect(p12.info).not.toContain('AES-256-CBC');
  });
});

describe('key สำรอง (escrow)', () => {
  function sealedFrom(body: IssueResponse) {
    return {
      kekId: body.escrow.kekId,
      encryptedKey: Buffer.from(body.escrow.encryptedKey, 'base64'),
      wrappedDataKey: Buffer.from(body.escrow.wrappedDataKey, 'base64'),
    };
  }

  it('ถอดได้ key ที่คู่กับใบรับรอง', async () => {
    const body = await issueOk();
    const der = openPrivateKey(sealedFrom(body), body.serialNumber);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    expect(new X509Certificate(body.certificatePem).checkPrivateKey(key)).toBe(true);
    expect(body.escrow.kekId).toBe(config.escrow.kekId);
  });

  it('ย้ายก้อนสำรองไปใช้กับ serial อื่น → ถอดไม่ได้', async () => {
    const body = await issueOk();
    expect(() => openPrivateKey(sealedFrom(body), 'abc123')).toThrow();
  });

  it('ข้อมูลถูกแก้ → ถอดไม่ได้', async () => {
    const body = await issueOk();
    const sealed = sealedFrom(body);
    sealed.encryptedKey[sealed.encryptedKey.length - 1]! ^= 0xff;
    expect(() => openPrivateKey(sealed, body.serialNumber)).toThrow();
  });
});

describe('ตรวจข้อมูลที่ส่งมา', () => {
  it.each([
    ['ชื่อยาวเกิน 64 ตัวอักษร', { commonName: 'ก'.repeat(65) }],
    ['ชื่อมีขึ้นบรรทัดใหม่', { commonName: 'สมชาย\nO=ปลอม' }],
    ['ชื่อว่าง', { commonName: '   ' }],
    ['อีเมลผิดรูปแบบ', { email: 'not-an-email' }],
    ['รหัสผ่านสั้นกว่า 8 ตัว', { p12Password: 'short' }],
  ])('%s → 400', async (_label, overrides) => {
    const res = await issue({ commonName: NAME, email: EMAIL, p12Password: PASSWORD, ...overrides });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
