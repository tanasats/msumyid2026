import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// TOTP ตาม RFC 6238 (HOTP RFC 4226 + เวลา) — ค่าที่แอป Authenticator ทุกตัวรองรับ: SHA-1, 6 หลัก, ช่วงละ 30 วินาที
// เขียนด้วย node:crypto เอง (ไม่เพิ่ม dependency) เหมือน PIN ลงนาม

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** ยอมรับรหัสของช่วงก่อน/หลัง 1 ช่วง (นาฬิกาโทรศัพท์คลาดเคลื่อน / ผู้ใช้พิมพ์ช้า) */
const ALLOWED_DRIFT_STEPS = 1;
/** secret 20 ไบต์ (160 บิต) ตามที่ RFC 4226 แนะนำสำหรับ HMAC-SHA1 */
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32 (RFC 4648) ไม่มี padding — รูปแบบที่ otpauth:// และการพิมพ์ secret เองใช้ */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function generateTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** ช่วงเวลา (counter) ของเวลาที่กำหนด */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP: HMAC-SHA1(secret, counter 8 ไบต์) → dynamic truncation → 6 หลัก */
export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * ตรวจรหัส — คืนช่วงเวลาที่รหัสตรง (ไว้บันทึกกันใช้ซ้ำ) หรือ null
 * afterStep = ช่วงล่าสุดที่เคยใช้ผ่าน: รหัสของช่วงนั้นหรือก่อนหน้าไม่รับ (กันคนที่เห็นรหัสแล้วนำไปใช้ซ้ำภายใน 30-60 วินาที)
 */
export function verifyTotp(secret: Buffer, code: string, now: Date, afterStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  const given = Buffer.from(code, 'utf8');
  let matched: number | null = null;
  // ตรวจครบทุกช่วงเสมอ (ไม่หยุดทันทีที่เจอ) เวลาที่ใช้จึงไม่บอกว่าตรงช่วงไหน
  for (let step = current - ALLOWED_DRIFT_STEPS; step <= current + ALLOWED_DRIFT_STEPS; step++) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    if (timingSafeEqual(expected, given) && (afterStep === null || step > afterStep) && matched === null) {
      matched = step;
    }
  }
  return matched;
}

/** URI สำหรับ QR code ที่แอป Authenticator สแกน (Key Uri Format ของ Google Authenticator) */
export function totpUri(input: { secret: Buffer; issuer: string; accountName: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
