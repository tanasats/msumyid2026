import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

// เข้ารหัส secret ของ TOTP ก่อนเก็บลงฐานข้อมูล (AES-256-GCM ด้วย MFA_ENCRYPTION_KEY) — แบบเดียวกับ key สำรองของ signer
// AAD ผูกกับ user_id: ย้าย ciphertext ไปใส่แถวของผู้ใช้อื่นแล้วจะถอดไม่ได้
// รูปแบบ: iv (12 ไบต์) + auth tag (16 ไบต์) + ciphertext

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const aad = (userId: string) => Buffer.from(`msumyid:mfa:totp:${userId}`, 'utf8');

export type SealedSecret = { keyId: string; ciphertext: Buffer };

export function sealTotpSecret(userId: string, secret: Buffer, key = config.mfa.encryptionKey): SealedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(userId));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { keyId: config.mfa.encryptionKeyId, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) };
}

/** throw เมื่อข้อมูลถูกแก้ / ผิดผู้ใช้ / ผิด key */
export function openTotpSecret(userId: string, sealed: SealedSecret, key = config.mfa.encryptionKey): Buffer {
  if (sealed.keyId !== config.mfa.encryptionKeyId) {
    throw new Error(`secret ของ MFA เข้ารหัสด้วย key ${sealed.keyId} ซึ่งไม่ใช่ key ปัจจุบัน`);
  }
  const data = sealed.ciphertext;
  if (data.length <= IV_LENGTH + TAG_LENGTH) throw new Error('ข้อมูล secret ของ MFA ไม่ครบ');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, IV_LENGTH));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  return Buffer.concat([decipher.update(data.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
}
