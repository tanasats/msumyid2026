import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    // migrate ฐาน app_test อัตโนมัติก่อนเริ่ม test
    globalSetup: ['./tests/global-setup.ts'],
    // test ใช้ฐานข้อมูลจริงร่วมกัน จึงรันทีละไฟล์เพื่อไม่ให้ข้อมูลชนกัน
    fileParallelism: false,
  },
});
