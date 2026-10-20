import { X509Certificate } from 'node:crypto';

// ใบรับรอง root ของ Thai University Consortium (ผู้ออกใบ CA ของมหาวิทยาลัยมหาสารคาม) ให้ผู้ใช้ดาวน์โหลดไปตั้งเป็น trusted root
// ใน Acrobat/Foxit — ข้อมูลสาธารณะ ไม่มี key ใช้ฝั่ง server เท่านั้น (node:crypto)
// ต้องตรงกับ apps/signer/ca/root.cert.pem ทุกไบต์ (test ใน apps/signer/tests/ca.test.ts ตรวจให้) — ต่ออายุ root แล้วแก้ทุกที่ (รวม apps/api/src/services/signature-verification/university-ca.ts)

const ROOT_CA_PEM = `
-----BEGIN CERTIFICATE-----
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
Wqab
-----END CERTIFICATE-----
`;

export const ROOT_CA_FILE_NAME = 'tuc-root-ca.cer';

export type RootCaInfo = {
  /** ไฟล์ .cer แบบ DER (ดับเบิลคลิกเปิดบน Windows ได้, Acrobat/Foxit นำเข้าได้) */
  der: Buffer;
  commonName: string;
  organization: string;
  validFrom: Date;
  validTo: Date;
  /** SHA-256 fingerprint แบบ AA:BB:... ให้ผู้ใช้เทียบกับที่โปรแกรมแสดง */
  sha256: string;
  sha1: string;
};

function subjectField(subject: string, key: string): string {
  return subject.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
}

let cached: RootCaInfo | null = null;

export function getRootCa(): RootCaInfo {
  if (!cached) {
    const cert = new X509Certificate(ROOT_CA_PEM.trim());
    cached = {
      der: cert.raw,
      commonName: subjectField(cert.subject, 'CN'),
      organization: subjectField(cert.subject, 'O'),
      validFrom: new Date(cert.validFrom),
      validTo: new Date(cert.validTo),
      sha256: cert.fingerprint256,
      sha1: cert.fingerprint,
    };
  }
  return cached;
}
