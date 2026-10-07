import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ค่า Google ของ test คงที่ ไม่ขึ้นกับ .env (test mock การเรียก Google ทั้งหมด)
    env: {
      NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:4010/auth/google/callback',
      ALLOWED_EMAIL_DOMAINS: 'msu.ac.th',
    },
    // migrate ฐาน app_test อัตโนมัติก่อนเริ่ม test
    globalSetup: ['./tests/global-setup.ts'],
    // test ใช้ฐานข้อมูลจริงร่วมกัน จึงรันทีละไฟล์เพื่อไม่ให้ข้อมูลชนกัน
    fileParallelism: false,
  },
});
