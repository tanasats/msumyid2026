import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { openPrivateKey } from '../src/services/escrow.js';
import { runOpenssl } from '../src/services/openssl.js';

// นำ key เดิมจากระบบสคริปต์ (openssl genrsa -aes256 ของ OpenSSL 1.1.1) มาเก็บเป็น key สำรอง
// สร้างไฟล์แบบเดียวกับสคริปต์เดิมด้วย OpenSSL จริง แล้วให้ CA ปลอมเซ็น

const app = createApp();
const TOKEN = process.env.SIGNER_TOKEN!;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'msumyid-legacy-key-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** สร้าง key + ใบรับรองแบบสคริปต์เดิม: genrsa -aes256 (PEM แบบ traditional) แล้ว CA เซ็นด้วย serial ที่กำหนด */
async function legacyCertificate(password: string, serialHex: string, signWithCa = true) {
  const name = crypto.randomUUID();
  const keyFile = path.join(workDir, `${name}.key.pem`);
  const csrFile = path.join(workDir, `${name}.csr`);
  const certFile = path.join(workDir, `${name}.cert.pem`);
  await runOpenssl('openssl', ['genrsa', '-aes256', '-traditional', '-passout', 'env:P', '-out', keyFile, '2048'], {
    secrets: { P: password },
  });
  await runOpenssl(
    'openssl',
    ['req', '-new', '-key', keyFile, '-passin', 'env:P', '-subj', '/C=TH/O=Mahasarakham University/CN=Legacy', '-out', csrFile],
    { secrets: { P: password } },
  );
  if (signWithCa) {
    await runOpenssl(
      'openssl',
      [
        'x509', '-req', '-in', csrFile, '-CA', config.ca.certPath, '-CAkey', config.ca.keyPath, '-passin', 'env:CAP',
        '-set_serial', `0x${serialHex}`, '-days', '365', '-out', certFile,
      ],
      { secrets: { CAP: config.ca.keyPassphrase } },
    );
  } else {
    await runOpenssl(
      'openssl',
      ['x509', '-req', '-in', csrFile, '-key', keyFile, '-passin', 'env:P', '-set_serial', `0x${serialHex}`, '-days', '1', '-out', certFile],
      { secrets: { P: password } },
    );
  }
  return {
    keyPem: await readFile(keyFile, 'utf8'),
    certificate: { serialNumber: serialHex.toLowerCase(), certificatePem: await readFile(certFile, 'utf8') },
  };
}

function escrowLegacy(body: object) {
  return request(app).post('/certificates/legacy-key').set('Authorization', `Bearer ${TOKEN}`).send(body);
}

describe('POST /certificates/legacy-key', () => {
  it('ไม่มี token → 401', async () => {
    expect((await request(app).post('/certificates/legacy-key').send({})).status).toBe(401);
  });

  it('ถอดด้วยรหัสผ่านที่ถูก (ลองทีละตัว) แล้วจับคู่กับใบที่ key ตรงกัน — key สำรองถอดกลับได้ key เดิม', async () => {
    const legacy = await legacyCertificate('pwgenPass123', 'a1b2c3d4');
    const other = await legacyCertificate('another-pass', 'a1b2c3d5');
    expect(legacy.keyPem).toContain('Proc-Type: 4,ENCRYPTED');

    const res = await escrowLegacy({
      privateKeyPem: legacy.keyPem,
      passphrases: ['old-wrong-pass', 'pwgenPass123'],
      certificates: [other.certificate, legacy.certificate],
    });

    expect(res.status).toBe(200);
    expect(res.body.serialNumber).toBe('a1b2c3d4');
    const der = openPrivateKey(
      {
        kekId: res.body.escrow.kekId,
        encryptedKey: Buffer.from(res.body.escrow.encryptedKey, 'base64'),
        wrappedDataKey: Buffer.from(res.body.escrow.wrappedDataKey, 'base64'),
      },
      'a1b2c3d4',
    );
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    expect(new X509Certificate(legacy.certificate.certificatePem).checkPrivateKey(key)).toBe(true);
  });

  it('รหัสผ่านไม่ถูกเลย → 422 KEY_DECRYPT_FAILED', async () => {
    const legacy = await legacyCertificate('right-pass', 'b1');
    const res = await escrowLegacy({ privateKeyPem: legacy.keyPem, passphrases: ['wrong'], certificates: [legacy.certificate] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_DECRYPT_FAILED');
  });

  it('key ไม่คู่กับใบใดที่ส่งมา → 422 KEY_NO_MATCHING_CERTIFICATE', async () => {
    const legacy = await legacyCertificate('pass-one', 'c1');
    const other = await legacyCertificate('pass-two', 'c2');
    const res = await escrowLegacy({ privateKeyPem: legacy.keyPem, passphrases: ['pass-one'], certificates: [other.certificate] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_NO_MATCHING_CERTIFICATE');
  });

  it('ใบที่ไม่ได้ออกโดย CA ของระบบ ไม่ถูกจับคู่ แม้ key จะตรง', async () => {
    const selfSigned = await legacyCertificate('pass-three', 'd1', false);
    const res = await escrowLegacy({
      privateKeyPem: selfSigned.keyPem,
      passphrases: ['pass-three'],
      certificates: [selfSigned.certificate],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KEY_NO_MATCHING_CERTIFICATE');
  });

  it('serial ที่ส่งมาไม่ตรงกับใบ → ไม่ถูกจับคู่', async () => {
    const legacy = await legacyCertificate('pass-four', 'e1');
    const res = await escrowLegacy({
      privateKeyPem: legacy.keyPem,
      passphrases: ['pass-four'],
      certificates: [{ ...legacy.certificate, serialNumber: 'e2' }],
    });
    expect(res.status).toBe(422);
  });
});
