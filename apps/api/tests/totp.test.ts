import { describe, expect, it } from 'vitest';
import { openTotpSecret, sealTotpSecret } from '../src/services/mfa-crypto.js';
import { base32Encode, hotp, totpStep, totpUri, verifyTotp } from '../src/services/totp.js';

// TOTP (RFC 6238) และการเข้ารหัส secret — ไม่ใช้ฐานข้อมูล

// secret ของ test vector ใน RFC 6238 ภาคผนวก B (SHA-1) — ค่าใน RFC เป็น 8 หลัก ใช้ 6 หลักท้าย
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP', () => {
  it.each(RFC_VECTORS)('ตรงกับ test vector ของ RFC 6238 ที่เวลา %i', (seconds, expected) => {
    expect(hotp(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(expected);
  });

  it('base32 ตาม RFC 4648 (ไม่มี padding)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('รับรหัสช่วงก่อน/หลัง 1 ช่วง ไม่รับที่ห่างกว่านั้น และไม่รับช่วงที่ใช้ไปแล้ว', () => {
    const now = new Date(1111111111 * 1000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now, null)).toBeNull();
    // ใช้รหัสของช่วงนี้ไปแล้ว → ช่วงนี้และก่อนหน้าใช้ไม่ได้ ช่วงถัดไปยังได้
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '1234567', now, null)).toBeNull();
  });

  it('otpauth URI มี issuer และ secret แบบ base32', () => {
    const uri = new URL(totpUri({ secret: Buffer.from('foobar'), issuer: 'MSU Digital ID', accountName: 'a@msu.ac.th' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/MSU Digital ID:a@msu.ac.th');
    expect(uri.searchParams.get('secret')).toBe('MZXW6YTBOI');
    expect(uri.searchParams.get('issuer')).toBe('MSU Digital ID');
  });
});

describe('เข้ารหัส secret', () => {
  it('ถอดได้เฉพาะผู้ใช้เดิม key เดิม และข้อมูลที่ไม่ถูกแก้', () => {
    const secret = Buffer.from('0123456789abcdefghij');
    const sealed = sealTotpSecret('user-a', secret);
    expect(sealed.keyId).toBe('test-1');
    expect(sealed.ciphertext.includes(secret)).toBe(false);
    expect(openTotpSecret('user-a', sealed)).toEqual(secret);

    expect(() => openTotpSecret('user-b', sealed)).toThrow();
    expect(() => openTotpSecret('user-a', sealed, Buffer.alloc(32, 1))).toThrow();
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => openTotpSecret('user-a', { ...sealed, ciphertext: tampered })).toThrow();
    expect(() => openTotpSecret('user-a', { ...sealed, keyId: 'old-1' })).toThrow();
  });
});
