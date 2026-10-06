// เรียก next dev/start โดยอ่าน PORT จาก .env.local (ห้ามฮาร์ดโค้ด port)
// ใช้สคริปต์นี้เพราะ next อ่าน .env.local หลังเลือก port ไปแล้ว และ npm script ใช้ ${PORT} ข้าม OS ไม่ได้
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  console.error('ใช้: node scripts/next.mjs <dev|start>');
  process.exit(1);
}

if (existsSync('.env.local')) {
  process.loadEnvFile('.env.local');
}

const port = process.env.PORT;
if (!port) {
  console.error('ต้องกำหนด PORT ใน apps/web/.env.local');
  process.exit(1);
}

const nextBin = createRequire(import.meta.url).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, command, '--port', port], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

// ส่งสัญญาณปิดต่อให้ next
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
