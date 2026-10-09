import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

// key สำรอง (escrow) แบบ envelope encryption:
// - private key (PKCS#8 DER) เข้ารหัสด้วย data key สุ่มใหม่ทุกก้อน (AES-256-GCM)
// - data key ถูกห่อด้วย KEK ของบริการนี้ (AES-256-GCM)
// - AAD ผูกกับ serial ของใบรับรอง: ย้ายก้อนข้อมูลไปใส่ใบอื่นในฐานข้อมูลแล้วจะถอดไม่ได้
// รูปแบบก้อนข้อมูล: iv (12 ไบต์) + auth tag (16 ไบต์) + ciphertext

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export type SealedKey = {
  kekId: string;
  encryptedKey: Buffer;
  wrappedDataKey: Buffer;
};

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length <= IV_LENGTH + TAG_LENGTH) throw new Error('ข้อมูล key สำรองไม่ครบ');
  const iv = sealed.subarray(0, IV_LENGTH);
  const tag = sealed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  // auth tag ไม่ตรง (ข้อมูลถูกแก้ / ผิดใบ / ผิด KEK) → final() throw
  return Buffer.concat([decipher.update(sealed.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
}

const keyAad = (serialNumber: string) => `msumyid:escrow:key:${serialNumber}`;
const dataKeyAad = (serialNumber: string, kekId: string) => `msumyid:escrow:dek:${kekId}:${serialNumber}`;

/** เข้ารหัส private key ของใบรับรอง serialNumber เพื่อเก็บสำรอง */
export function sealPrivateKey(pkcs8Der: Buffer, serialNumber: string): SealedKey {
  const dataKey = randomBytes(32);
  try {
    return {
      kekId: config.escrow.kekId,
      encryptedKey: seal(dataKey, pkcs8Der, keyAad(serialNumber)),
      wrappedDataKey: seal(config.escrow.kek, dataKey, dataKeyAad(serialNumber, config.escrow.kekId)),
    };
  } finally {
    dataKey.fill(0);
  }
}

/** ถอด private key (PKCS#8 DER) จากก้อนสำรอง — ใช้ตอนกู้ key และลงนามเอกสาร */
export function openPrivateKey(sealed: SealedKey, serialNumber: string): Buffer {
  // ตอนนี้มี KEK ตัวเดียว — เมื่อเปลี่ยน KEK ให้เพิ่มรายการ KEK เก่าไว้ถอดก้อนเดิม
  if (sealed.kekId !== config.escrow.kekId) {
    throw new Error(`ไม่พบ KEK "${sealed.kekId}"`);
  }
  const dataKey = open(config.escrow.kek, sealed.wrappedDataKey, dataKeyAad(serialNumber, sealed.kekId));
  try {
    return open(dataKey, sealed.encryptedKey, keyAad(serialNumber));
  } finally {
    dataKey.fill(0);
  }
}
