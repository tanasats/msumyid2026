import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSecretFiles } from '../src/config/secret-files.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'secret-files-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadSecretFiles (Docker secret: NAME_FILE)', () => {
  it('อ่านค่าจากไฟล์และตัดขึ้นบรรทัดใหม่ท้ายไฟล์', async () => {
    const file = path.join(dir, 'token');
    await writeFile(file, 'abc123\n');
    const env: NodeJS.ProcessEnv = { SIGNER_TOKEN_FILE: file };
    loadSecretFiles(env, ['SIGNER_TOKEN']);
    expect(env.SIGNER_TOKEN).toBe('abc123');
  });

  it('ไม่มี NAME_FILE = ใช้ค่า NAME เดิม (dev)', () => {
    const env: NodeJS.ProcessEnv = { SIGNER_TOKEN: 'from-env' };
    loadSecretFiles(env, ['SIGNER_TOKEN']);
    expect(env.SIGNER_TOKEN).toBe('from-env');
  });

  it('กำหนดทั้ง NAME และ NAME_FILE = ผิด', async () => {
    const file = path.join(dir, 'token2');
    await writeFile(file, 'x');
    expect(() => loadSecretFiles({ SIGNER_TOKEN: 'a', SIGNER_TOKEN_FILE: file }, ['SIGNER_TOKEN'])).toThrow(
      /พร้อมกันไม่ได้/,
    );
  });

  it('ไฟล์ไม่มีอยู่ = error (ไม่เริ่มระบบด้วยค่าว่าง)', () => {
    expect(() => loadSecretFiles({ SIGNER_TOKEN_FILE: path.join(dir, 'missing') }, ['SIGNER_TOKEN'])).toThrow();
  });
});
