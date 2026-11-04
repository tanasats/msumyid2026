// การยืนยันตัวตนสองขั้นตอน (MFA) — docs/design/mfa.md
// ชนิดข้อมูลใช้ได้ทั้ง Server และ Client Component (ไม่ import api-server ที่นี่)

/** GET /me/mfa */
export type MfaStatus = {
  /** เปิดใช้งานแล้ว (ยืนยันรหัสแรกแล้ว) */
  enabled: boolean;
  /** เริ่มตั้งค่าแล้วแต่ยังไม่ยืนยัน */
  pending: boolean;
  recoveryCodesRemaining: number;
  lockedUntil: string | null;
  /** บทบาทที่ถือบังคับ MFA (ปิดเองไม่ได้) */
  required: boolean;
};

/** POST /me/mfa/totp/setup */
export type MfaSetup = { otpauthUri: string; secret: string };

/** รหัสกู้คืนชุดใหม่ (แสดงครั้งเดียว) */
export type RecoveryCodes = { recoveryCodes: string[] };

/** แบ่ง secret base32 เป็นกลุ่มละ 4 ตัวให้พิมพ์ตามง่าย */
export function formatSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

/** ไฟล์ข้อความรหัสกู้คืนสำหรับดาวน์โหลด */
export function recoveryCodesText(codes: string[], email: string): string {
  return [
    'รหัสกู้คืนการยืนยันตัวตนสองขั้นตอน — MSU Digital ID',
    `บัญชี: ${email}`,
    '',
    'ใช้แทนรหัสจากแอป Authenticator ได้รหัสละ 1 ครั้ง เมื่อโทรศัพท์หายหรือใช้แอปไม่ได้',
    'เก็บไว้ในที่ปลอดภัย อย่าส่งให้ผู้อื่น',
    '',
    ...codes,
    '',
  ].join('\n');
}
