import { readFileSync } from 'node:fs';

/**
 * อ่าน secret จากไฟล์ (Docker secret) ก่อนตรวจ env: กำหนด NAME_FILE=/run/secrets/x แทน NAME
 * production ใช้วิธีนี้กับ passphrase/KEK/token เพื่อไม่ให้ค่าจริงอยู่ใน env ของ container (docker inspect เห็น)
 * dev ยังใส่ NAME ตรง ๆ ใน .env ได้เหมือนเดิม — กำหนดทั้งสองแบบพร้อมกัน = ผิด
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    if (env[name]) {
      throw new Error(`กำหนด ${name} และ ${name}_FILE พร้อมกันไม่ได้`);
    }
    // ตัดขึ้นบรรทัดใหม่ท้ายไฟล์ (echo/printf ใส่มา) ค่าที่ใช้จึงตรงกับที่สร้าง
    env[name] = readFileSync(file, 'utf8').trim();
  }
}
