import { rm } from 'node:fs/promises';
import { createDevCa } from '../scripts/create-dev-ca.js';
import { TEST_CA_DIR, TEST_CA_PASSPHRASE } from '../vitest.config.js';

// สร้าง CA ปลอมใหม่ทุกครั้งก่อนเริ่ม test (ไม่ใช้ของรอบก่อน)
export default async function setup() {
  await rm(TEST_CA_DIR, { recursive: true, force: true });
  await createDevCa(TEST_CA_DIR, { passphrase: TEST_CA_PASSPHRASE });
}
