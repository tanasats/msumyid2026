import { hotp, totpStep } from '../../src/services/totp.js';

// ตัวช่วย test ของ MFA — ทำตัวเป็นแอป Authenticator

/** ถอด secret แบบ base32 (RFC 4648 ไม่มี padding) ที่ API คืนตอนเริ่มตั้งค่า */
export function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** รหัส 6 หลักของช่วงเวลาปัจจุบัน (offset = เลื่อนไปกี่ช่วง 30 วินาที) */
export const codeFor = (secret: Buffer, offset = 0) => hotp(secret, totpStep(new Date()) + offset);
