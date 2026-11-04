import { parseArgs } from 'node:util';
import { pool } from '../src/db/pool.js';
import { resetMfaByEmail, type CliMfaResetResult } from '../src/services/mfa-service.js';

// รีเซ็ต MFA ของผู้ใช้จากเซิร์ฟเวอร์ — ทางออกฉุกเฉินเมื่อไม่มีผู้ดูแลที่เข้าระบบได้ (docs/design/mfa.md)
// ใช้: pnpm --filter api mfa:reset -- --email <อีเมล> --reason "<เหตุผล>"
// production (บน VM): docker compose run --rm api node dist/scripts/mfa-reset.js --email ... --reason "..."

type Failure = Extract<CliMfaResetResult, { ok: false }>['reason'];

const FAILURE_MESSAGES: Record<Failure, string> = {
  USER_NOT_FOUND: 'ไม่พบผู้ใช้ email นี้',
  AMBIGUOUS_EMAIL: 'พบผู้ใช้มากกว่า 1 บัญชีที่ใช้ email นี้ — ตรวจสอบในฐานข้อมูลก่อน',
  MFA_NOT_ENABLED: 'บัญชีนี้ยังไม่ได้เปิดการยืนยันตัวตนสองขั้นตอน',
};

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { email: { type: 'string' }, reason: { type: 'string' } } });
  const email = values.email?.trim();
  const reason = values.reason?.trim();
  if (!email || !reason) {
    console.error('ใช้: pnpm --filter api mfa:reset -- --email <อีเมล> --reason "<เหตุผล>"');
    return 1;
  }
  const result = await resetMfaByEmail(email, reason.slice(0, 500));
  if (!result.ok) {
    console.error(`ไม่สำเร็จ: ${FAILURE_MESSAGES[result.reason]}`);
    return 1;
  }
  console.log(
    `รีเซ็ต MFA ของ ${email} แล้ว (ออกจากระบบ ${result.revokedSessions} อุปกรณ์) — เข้าสู่ระบบครั้งถัดไปตั้งค่าใหม่ได้`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('รีเซ็ต MFA ล้มเหลว:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
