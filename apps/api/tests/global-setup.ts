import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

// รัน migration ทั้งหมดกับ app_test ก่อนเริ่ม test (CLAUDE.md หัวข้อ 12)
export default async function setup() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('ต้องกำหนด TEST_DATABASE_URL ใน apps/api/.env');
  }
  // กันพลาดรัน test กับฐาน dev
  if (!new URL(databaseUrl).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL ต้องชี้ไปที่ฐานที่ลงท้ายด้วย _test');
  }

  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
  await runner({
    databaseUrl,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
