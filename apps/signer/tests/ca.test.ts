import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevCa } from '../scripts/create-dev-ca.js';
import { config } from '../src/config/index.js';
import { loadCa, parsePemCertificates, readCa } from '../src/services/ca.js';
import { validityDays } from '../src/services/certificate-issuer.js';
import { runOpenssl } from '../src/services/openssl.js';
import { AppError } from '../src/errors.js';

// สายใบรับรองของ CA (CA_CHAIN_PATH) และการจำกัดอายุใบไม่ให้เกินวันหมดอายุของ CA

const DAY_MS = 24 * 60 * 60 * 1000;
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'msumyid-signer-ca-test-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('สายใบรับรองของ CA', () => {
  it('โหลด CA พร้อม root ได้ bundle = Intermediate + root และวันหมดอายุ = ใบที่หมดก่อน', async () => {
    const ca = await loadCa();
    expect(ca.chain).toHaveLength(1);
    expect(parsePemCertificates(ca.bundlePem).map((c) => c.subject)).toEqual([ca.cert.subject, ca.chain[0]!.subject]);
    const earliest = Math.min(new Date(ca.cert.validTo).getTime(), new Date(ca.chain[0]!.validTo).getTime());
    expect(ca.notAfter.getTime()).toBe(earliest);
  });

  it('ไม่ตั้ง CA_CHAIN_PATH → มีแค่ Intermediate', async () => {
    const ca = await readCa({ ...config.ca, chainPath: undefined });
    expect(ca.chain).toHaveLength(0);
    expect(parsePemCertificates(ca.bundlePem)).toHaveLength(1);
  });

  it('root ที่ไม่ได้ออก Intermediate นี้ → โหลดไม่ได้', async () => {
    const other = await createDevCa(path.join(workDir, 'other-ca'), { passphrase: 'other-passphrase' });
    await expect(readCa({ ...config.ca, chainPath: other.chainPath })).rejects.toThrow(/ไม่ได้ออก/);
  });

  it('ใบใน CA_CHAIN_PATH ไม่ใช่ CA → โหลดไม่ได้', async () => {
    const file = path.join(workDir, 'leaf.cert.pem');
    await runOpenssl('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', path.join(workDir, 'leaf.key.pem'), '-out', file,
      '-subj', '/CN=leaf', '-days', '1', '-addext', 'basicConstraints=critical,CA:FALSE',
    ]);
    await expect(readCa({ ...config.ca, chainPath: file })).rejects.toThrow(/ไม่ใช่ใบของ CA/);
  });

  it('ไฟล์ CA_CHAIN_PATH ไม่มีใบรับรอง → โหลดไม่ได้', async () => {
    const file = path.join(workDir, 'empty.pem');
    await writeFile(file, 'not a certificate\n');
    await expect(readCa({ ...config.ca, chainPath: file })).rejects.toThrow(/ไม่พบใบรับรอง/);
  });

  it('ใบของมหาวิทยาลัยใน apps/signer/ca ออกโดย root ของ Thai University Consortium', async () => {
    const dir = path.join(import.meta.dirname, '..', 'ca');
    const [univ] = parsePemCertificates(await readFile(path.join(dir, 'univ-ca.cert.pem'), 'utf8'));
    const [root] = parsePemCertificates(await readFile(path.join(dir, 'root.cert.pem'), 'utf8'));
    expect(univ!.ca && root!.ca).toBe(true);
    expect(univ!.checkIssued(root!) && univ!.verify(root!.publicKey)).toBe(true);
    expect(univ!.subject).toContain('O=Mahasarakham University');
  });
});

describe('อายุใบรับรองไม่เกินวันหมดอายุของ CA', () => {
  const now = new Date('2029-06-01T00:00:00Z');

  it('CA เหลืออายุมาก → ใช้ CERT_VALIDITY_DAYS', () => {
    expect(validityDays(new Date(now.getTime() + 1000 * DAY_MS), now, 365)).toBe(365);
  });

  it('CA เหลือน้อยกว่า CERT_VALIDITY_DAYS → ตัดให้หมดไม่เกิน CA (ปัดลง)', () => {
    const caNotAfter = new Date(now.getTime() + 297.5 * DAY_MS);
    const days = validityDays(caNotAfter, now, 365);
    expect(days).toBe(297);
    expect(now.getTime() + days * DAY_MS).toBeLessThanOrEqual(caNotAfter.getTime());
  });

  it('CA เหลือไม่ถึง 1 วัน หรือหมดแล้ว → CA_EXPIRING', () => {
    for (const caNotAfter of [new Date(now.getTime() + 0.5 * DAY_MS), new Date(now.getTime() - DAY_MS)]) {
      const err = (() => {
        try {
          validityDays(caNotAfter, now, 365);
        } catch (e) {
          return e;
        }
        return null;
      })();
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('CA_EXPIRING');
    }
  });
});
