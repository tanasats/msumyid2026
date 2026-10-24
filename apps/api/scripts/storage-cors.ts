import { config } from '../src/config/index.js';
import { applyBucketCors } from '../src/storage/index.js';

// ตั้ง CORS ของ bucket ให้หน้าเว็บ (WEB_URL) อัปโหลด/ดาวน์โหลดด้วย presigned URL ได้ — รันซ้ำได้ (ตั้งทับค่าเดิม)
// ใช้: pnpm --filter api storage:cors
// dev ต้องใช้ (web :3010 กับ Garage :3910 คนละ origin) / production ไม่จำเป็น (nginx ส่งต่อใต้โดเมนเดียวกัน)

applyBucketCors(config.webUrl).then(
  () => {
    console.log(`ตั้ง CORS ของ bucket '${config.s3.bucket}' ให้ ${config.webUrl} แล้ว`);
    process.exit(0);
  },
  (err: unknown) => {
    console.error('ตั้ง CORS ไม่สำเร็จ:', err);
    process.exit(1);
  },
);
