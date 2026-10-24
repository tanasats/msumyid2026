import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ค่า Google ของ test คงที่ ไม่ขึ้นกับ .env (test mock การเรียก Google ทั้งหมด)
    env: {
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:4010/auth/google/callback',
      // โดเมน .invalid ไม่มีจริง — test ต้อง mock erpHr เสมอ ถ้าหลุดไปเรียกจริงจะล้มทันที
      ERP_HR_STAFFINFO_URL: 'https://erp.test.invalid/service/api/staffinfo',
      // บริการเซ็น: test ของ API mock signer เสมอ (signer มี test ของตัวเองกับ OpenSSL จริง)
      SIGNER_URL: 'http://signer.test.invalid',
      SIGNER_TOKEN: 'test-signer-token-0123456789abcdef0123456789',
      // ที่เก็บไฟล์: test ของ API แทน storage ด้วย memoryStorage (tests/helpers/storage.ts) — โดเมน .invalid กันหลุดไปเรียกจริง
      S3_ENDPOINT: 'http://s3.test.invalid',
      S3_PUBLIC_ENDPOINT: 'http://s3-public.test.invalid',
      S3_ACCESS_KEY: 'test-access-key',
      S3_SECRET_KEY: 'test-secret-key',
      S3_BUCKET: 'app-files-test',
    },
    // migrate ฐาน app_test อัตโนมัติก่อนเริ่ม test
    globalSetup: ['./tests/global-setup.ts'],
    // test ใช้ฐานข้อมูลจริงร่วมกัน จึงรันทีละไฟล์เพื่อไม่ให้ข้อมูลชนกัน
    fileParallelism: false,
  },
});
