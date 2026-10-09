import { execFile } from 'node:child_process';

// ตัวแปรของระบบที่ OpenSSL ต้องใช้ — ไม่ส่ง env ทั้งหมดของ process ต่อ (มี passphrase ของ CA และ KEK อยู่)
const PASSTHROUGH_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR'];

export type OpensslOptions = {
  /** ความลับที่ส่งให้ OpenSSL ผ่าน env (อ้างด้วย -passin env:NAME) ห้ามส่งเป็น argument เพราะเห็นได้จาก ps */
  secrets?: Record<string, string>;
  cwd?: string;
};

/**
 * เรียก OpenSSL CLI โดยไม่ผ่าน shell (argument ไม่ถูกตีความ จึงไม่มีช่อง command injection)
 * คืน stdout เป็น Buffer — exit code ไม่ใช่ 0 = throw พร้อม stderr
 */
export function runOpenssl(bin: string, args: string[], options: OpensslOptions = {}): Promise<Buffer> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, options.secrets);

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, cwd: options.cwd, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr.toString('utf8').trim().slice(0, 1000);
          reject(new Error(`openssl ${args[0]} ล้มเหลว: ${detail || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
