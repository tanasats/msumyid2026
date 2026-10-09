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
  createdAt: string;
};

/** ผลจาก POST /me/certificates — p12 เป็น base64 ได้ครั้งเดียว ระบบไม่เก็บไฟล์ */
export type IssuedCertificateResponse = {
  certificate: Certificate;
  p12: string;
  fileName: string;
};

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  active: 'ใช้งานได้',
  expired: 'หมดอายุ',
  revoked: 'เพิกถอนแล้ว',
};
