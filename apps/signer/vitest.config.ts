import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// CA ปลอมสำหรับ test สร้างใหม่ทุกครั้งใน global-setup (ที่เดียวกับ path ด้านล่าง)
export const TEST_CA_DIR = path.join(tmpdir(), 'msumyid-signer-test-ca');
export const TEST_CA_PASSPHRASE = 'test-ca-passphrase';

export default defineConfig({
  test: {
    // ค่า test คงที่ ไม่ขึ้นกับ .env
    env: {
      NODE_ENV: 'test',
      SIGNER_PORT: '4020',
      SIGNER_TOKEN: 'test-signer-token-0123456789abcdef0123456789',
      CA_CERT_PATH: path.join(TEST_CA_DIR, 'intermediate.cert.pem'),
      CA_KEY_PATH: path.join(TEST_CA_DIR, 'intermediate.key.pem'),
      CA_KEY_PASSPHRASE: TEST_CA_PASSPHRASE,
      CA_CHAIN_PATH: path.join(TEST_CA_DIR, 'root.cert.pem'),
      ESCROW_KEK: Buffer.alloc(32, 7).toString('base64'),
      ESCROW_KEK_ID: 'test-1',
      CRL_DISTRIBUTION_URL: 'https://cdp.msu.ac.th/msu-ca.crl',
      // key 2048 บิตให้ test เร็ว (production ใช้ค่าเริ่มต้น 4096)
      USER_KEY_BITS: '2048',
    },
    globalSetup: ['./tests/global-setup.ts'],
  },
});
