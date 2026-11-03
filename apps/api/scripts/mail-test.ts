import { parseArgs } from 'node:util';
import { config } from '../src/config/index.js';
import { isSendableAddress } from '../src/mail/mime.js';
import { mailTransport } from '../src/mail/transport.js';

// ส่งอีเมลทดสอบ 1 ฉบับตรง ๆ (ไม่ผ่านคิว) เพื่อตรวจค่า MAIL_* / GMAIL_* หลังตั้งค่าหรือเปลี่ยน token
// dev: pnpm --filter api mail:test -- --to you@msu.ac.th
// production: docker compose run --rm api node dist/scripts/mail-test.js --to you@msu.ac.th

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { to: { type: 'string' } } });
  if (!values.to || !isSendableAddress(values.to)) {
    console.error('ใช้: mail:test -- --to อีเมลผู้รับ');
    return 1;
  }
  if (config.mail.transport !== 'gmail') {
    console.warn('MAIL_TRANSPORT=log — ไม่ส่งจริง ดูผลใน log แทน');
  }
  await mailTransport.send({
    to: values.to,
    toName: null,
    subject: 'ทดสอบการส่งอีเมลจากระบบ MSU Digital ID',
    text: `อีเมลทดสอบจาก ${config.webUrl}\nถ้าได้รับฉบับนี้ แปลว่าระบบส่งอีเมลแจ้งเตือนได้แล้ว`,
  });
  console.log(`ส่งถึง ${values.to} แล้ว (ผู้ส่ง ${config.mail.fromAddress ?? '-'})`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('ส่งไม่สำเร็จ:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
