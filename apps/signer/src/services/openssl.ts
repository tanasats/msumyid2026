import { execFile } from 'node:child_process';
import path from 'node:path';

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

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * เวลาแบบ ASN.1: UTCTime (YYMMDDHHMMSSZ) ก่อนปี 2050 ตาม RFC 5280 หรือ GeneralizedTime (YYYYMMDDHHMMSSZ)
 * openssl ca รับวันเพิกถอนใน index.txt แบบ UTCTime เท่านั้น
 */
export function asn1Time(date: Date, form: 'utc' | 'generalized' = 'utc'): string {
  const y = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  if (form === 'utc' && y >= 2050) throw new Error('วันที่ตั้งแต่ปี 2050 ใช้ UTCTime ไม่ได้');
  return form === 'utc' ? `${String(y % 100).padStart(2, '0')}${rest}` : `${y}${rest}`;
}

/** ฐาน 16 ตัวพิมพ์ใหญ่ ความยาวคู่ (รูปแบบเดียวกับที่ openssl ca เขียนใน index.txt / crlnumber / serial) */
export function evenHex(hex: string): string {
  const upper = hex.toUpperCase();
  return upper.length % 2 === 0 ? upper : `0${upper}`;
}

/** path ในไฟล์ config ของ OpenSSL: ใช้ / (\ คืออักขระ escape) และใส่ \ หน้า $ (แทนค่าตัวแปร) */
export function confPath(p: string): string {
  return p.split(path.sep).join('/').replace(/[$#"']/g, (c) => `\\${c}`);
}
