// ชนิดข้อมูลใบรับรอง — ใช้ได้ทั้ง Server และ Client Component (ไม่ import โมดูลฝั่ง server)

export type CertificateStatus = 'active' | 'expired' | 'revoked';

/** ใบรับรองตามที่ API GET /me/certificates ส่งมา */
export type Certificate = {
  id: string;
  serialNumber: string;
  subjectCn: string;
  email: string;
  notBefore: string;
  notAfter: string;
  status: CertificateStatus;
  revokedAt: string | null;
  revocationReason: string | null;
  /** imported = ใบที่ออกด้วยสคริปต์ของระบบเดิมแล้วนำเข้ามา */
  source: 'issued' | 'imported';
  fingerprintSha256: string;
  /** มี key สำรอง = ดาวน์โหลดไฟล์ .p12 ใหม่ได้ */
  hasKeyEscrow: boolean;
  createdAt: string;
};

/** ไฟล์ .p12 จาก API (ขอใบใหม่ / ดาวน์โหลดใหม่จาก key สำรอง) — base64 ได้ครั้งเดียว ระบบไม่เก็บไฟล์ */
export type P12Response = {
  p12: string;
  fileName: string;
};

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  active: 'ใช้งานได้',
  expired: 'หมดอายุ',
  revoked: 'เพิกถอนแล้ว',
};

/** เพิกถอนเพราะ key อาจหลุด — API ไม่สร้าง .p12 ใหม่ให้ (KEY_COMPROMISED) */
export function isKeyCompromised(c: Pick<Certificate, 'revocationReason'>): boolean {
  return c.revocationReason === 'keyCompromise';
}

/** ดาวน์โหลด .p12 ใหม่ได้ = มี key สำรอง และไม่ได้เพิกถอนเพราะ key อาจหลุด (ซ่อนปุ่มเพื่อ UX — API ตรวจอีกครั้ง) */
export function canRedownload(c: Pick<Certificate, 'hasKeyEscrow' | 'revocationReason'>): boolean {
  return c.hasKeyEscrow && !isKeyCompromised(c);
}

export type RevocationReasonOption = { value: string; label: string; hint?: string };

// เหตุผลที่ผู้ใช้เลือกได้เมื่อเพิกถอนใบของตัวเอง (ตรงกับ SELF_REVOCATION_REASONS ของ API)
export const SELF_REVOCATION_REASONS: RevocationReasonOption[] = [
  {
    value: 'keyCompromise',
    label: 'ไฟล์หรือรหัสผ่านอาจหลุดไปถึงผู้อื่น',
    hint: 'เช่น ทำเครื่องหรือไฟล์ .p12 หาย ส่งไฟล์ผิดคน',
  },
  { value: 'superseded', label: 'ได้ใบรับรองใหม่มาแทนแล้ว' },
  { value: 'affiliationChanged', label: 'ข้อมูลในใบรับรองไม่ถูกต้องแล้ว', hint: 'เช่น เปลี่ยนชื่อ ย้ายสังกัด' },
  { value: 'cessationOfOperation', label: 'ไม่ใช้งานใบรับรองนี้แล้ว' },
];

// เหตุผลที่ผู้ดูแลเลือกได้ (ตรงกับ ADMIN_REVOCATION_REASONS ของ API)
export const ADMIN_REVOCATION_REASONS: RevocationReasonOption[] = [
  { value: 'keyCompromise', label: 'key อาจหลุดไปถึงผู้อื่น' },
  { value: 'affiliationChanged', label: 'ข้อมูลในใบรับรองไม่ถูกต้อง / ย้ายสังกัด' },
  { value: 'superseded', label: 'ออกใบใหม่แทนแล้ว' },
  { value: 'cessationOfOperation', label: 'เลิกใช้งาน / พ้นสภาพ' },
  { value: 'unspecified', label: 'ไม่ระบุ' },
];
