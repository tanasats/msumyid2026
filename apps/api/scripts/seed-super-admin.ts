import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { seedInitialSuperAdmin, type SeedSuperAdminResult } from '../src/services/super-admin-seed-service.js';

// สร้างผู้ดูแลระบบสูงสุดคนแรกจาก INITIAL_SUPER_ADMIN_EMAIL
// ใช้: pnpm --filter api seed:super-admin (เจ้าของ email ต้อง login ด้วย Google 1 ครั้งก่อน)

type Failure = Extract<SeedSuperAdminResult, { ok: false }>['reason'];

const FAILURE_MESSAGES: Record<Failure, string> = {
  USER_NOT_FOUND: 'ไม่พบผู้ใช้ email นี้ — ให้เจ้าของ email เข้าสู่ระบบด้วย Google 1 ครั้งก่อน',
  AMBIGUOUS_EMAIL: 'พบผู้ใช้มากกว่า 1 บัญชีที่ใช้ email นี้ — ตรวจสอบในฐานข้อมูลก่อน',
  INACTIVE: 'บัญชีนี้ถูกระงับการใช้งาน',
  NOT_APPROVED: 'บัญชีนี้ยังไม่ได้รับการอนุมัติ',
  SUPER_ADMIN_EXISTS: 'มีผู้ดูแลระบบสูงสุดอยู่แล้ว — ผู้ดูแลระบบสูงสุดคนต่อไปต้องให้ผ่านระบบจัดการสิทธิ์',
};

async function main(): Promise<number> {
  const email = config.initialSuperAdminEmail;
  if (!email) {
    console.error('ต้องกำหนด INITIAL_SUPER_ADMIN_EMAIL ใน apps/api/.env');
    return 1;
  }

  const result = await seedInitialSuperAdmin(email);
  if (!result.ok) {
    console.error(`ไม่สำเร็จ: ${FAILURE_MESSAGES[result.reason]}`);
    return 1;
  }
  console.log(
    result.status === 'granted'
      ? `ให้สิทธิ์ผู้ดูแลระบบสูงสุดแก่ ${email} แล้ว`
      : `${email} เป็นผู้ดูแลระบบสูงสุดอยู่แล้ว (ไม่มีการเปลี่ยนแปลง)`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('seed ล้มเหลว:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
