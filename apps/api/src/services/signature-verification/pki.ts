import { createHash, webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

// pkijs ใช้ WebCrypto ของ Node (ไม่มี native dependency) — ตั้งครั้งเดียวตอนโหลดโมดูล
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as unknown as Crypto }));

export { pkijs, asn1js };

const OID = {
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  country: '2.5.4.6',
  email: '1.2.840.113549.1.9.1',
  subjectAltName: '2.5.29.17',
  extKeyUsage: '2.5.29.37',
  keyUsage: '2.5.29.15',
} as const;

const NAME_LABELS: Record<string, string> = {
  [OID.commonName]: 'CN',
  [OID.organization]: 'O',
  [OID.organizationalUnit]: 'OU',
  [OID.country]: 'C',
  [OID.email]: 'E',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
};

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function parseCertificatePem(pem: string): pkijs.Certificate {
  const base64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s/g, '');
  return pkijs.Certificate.fromBER(toArrayBuffer(Buffer.from(base64, 'base64')));
}

export function certificateDer(certificate: pkijs.Certificate): Buffer {
  return Buffer.from(certificate.toSchema().toBER(false));
}

export function fingerprintSha256(certificate: pkijs.Certificate): string {
  return createHash('sha256').update(certificateDer(certificate)).digest('hex');
}

/** serial แบบเดียวกับคอลัมน์ certificates.serial_number: hex ตัวเล็ก ไม่มี 0 นำหน้า */
export function serialHex(certificate: pkijs.Certificate): string {
  const hex = Buffer.from(certificate.serialNumber.valueBlock.valueHexView).toString('hex').replace(/^0+/, '');
  return hex.length > 0 ? hex : '0';
}

function attributeValue(value: unknown): string {
  // ค่าใน DN เป็นสตริงหลายชนิด (UTF8String, PrintableString, BMPString, IA5String) — asn1js ถอดให้แล้วใน valueBlock.value
  const block = (value as { valueBlock?: { value?: unknown } }).valueBlock;
  return typeof block?.value === 'string' ? block.value : '';
}

export function nameAttributes(name: pkijs.RelativeDistinguishedNames): { type: string; value: string }[] {
  return name.typesAndValues.map((tv) => ({ type: tv.type, value: attributeValue(tv.value) }));
}

export function nameValue(name: pkijs.RelativeDistinguishedNames, oid: string): string | null {
  return nameAttributes(name).find((a) => a.type === oid)?.value || null;
}

/** DN แบบอ่านง่าย เช่น "CN=..., O=..., C=TH" */
export function formatName(name: pkijs.RelativeDistinguishedNames): string {
  return nameAttributes(name)
    .filter((a) => a.value)
    .map((a) => `${NAME_LABELS[a.type] ?? a.type}=${a.value}`)
    .join(', ');
}

export function displayName(name: pkijs.RelativeDistinguishedNames): string {
  return nameValue(name, OID.commonName) ?? nameValue(name, OID.organization) ?? formatName(name);
}

export function certificateEmail(certificate: pkijs.Certificate): string | null {
  const fromSubject = nameValue(certificate.subject, OID.email);
  if (fromSubject) return fromSubject;
  const san = certificate.extensions?.find((e) => e.extnID === OID.subjectAltName)?.parsedValue;
  if (san instanceof pkijs.AltName) {
    // GeneralName type 1 = rfc822Name
    const email = san.altNames.find((n) => n.type === 1);
    if (email && typeof email.value === 'string') return email.value;
  }
  return null;
}

export function certificateSummary(certificate: pkijs.Certificate) {
  return {
    commonName: nameValue(certificate.subject, OID.commonName),
    organization: nameValue(certificate.subject, OID.organization),
    email: certificateEmail(certificate),
    subject: formatName(certificate.subject),
    issuer: formatName(certificate.issuer),
    serialNumber: serialHex(certificate),
    notBefore: certificate.notBefore.value.toISOString(),
    notAfter: certificate.notAfter.value.toISOString(),
  };
}

export function isWithinValidity(certificate: pkijs.Certificate, at: Date): boolean {
  return certificate.notBefore.value <= at && at <= certificate.notAfter.value;
}

// EKU ที่ยอมรับสำหรับลงนามเอกสาร (แบบที่ Acrobat ยอมรับ) — ใบของ มมส. ปัจจุบันเป็น emailProtection
const SIGNING_EKUS = new Set([
  '1.3.6.1.5.5.7.3.4', // emailProtection
  '1.3.6.1.5.5.7.3.36', // documentSigning (RFC 9336)
  '1.3.6.1.4.1.311.10.3.12', // Microsoft Document Signing
  '1.2.840.113583.1.1.5', // Adobe Authentic Documents Trust
  '2.5.29.37.0', // anyExtendedKeyUsage
]);
const TIMESTAMPING_EKU = '1.3.6.1.5.5.7.3.8';

function extendedKeyUsages(certificate: pkijs.Certificate): string[] | null {
  const ext = certificate.extensions?.find((e) => e.extnID === OID.extKeyUsage)?.parsedValue;
  return ext instanceof pkijs.ExtKeyUsage ? ext.keyPurposes : null;
}

/** ใบที่ไม่ระบุ EKU ใช้ได้ทุกวัตถุประสงค์ */
export function allowsDocumentSigning(certificate: pkijs.Certificate): boolean {
  const ekus = extendedKeyUsages(certificate);
  return ekus === null || ekus.some((eku) => SIGNING_EKUS.has(eku));
}

export function allowsTimestamping(certificate: pkijs.Certificate): boolean {
  const ekus = extendedKeyUsages(certificate);
  return ekus === null || ekus.includes(TIMESTAMPING_EKU);
}

/** keyUsage ต้องมี digitalSignature หรือ nonRepudiation (ถ้าใบระบุ keyUsage) */
export function allowsDigitalSignature(certificate: pkijs.Certificate): boolean {
  const ext = certificate.extensions?.find((e) => e.extnID === OID.keyUsage)?.parsedValue;
  if (!(ext instanceof asn1js.BitString)) return true;
  const firstByte = ext.valueBlock.valueHexView[0] ?? 0;
  // bit 0 (0x80) = digitalSignature, bit 1 (0x40) = nonRepudiation
  return (firstByte & 0xc0) !== 0;
}

export function sameCertificate(a: pkijs.Certificate, b: pkijs.Certificate): boolean {
  return certificateDer(a).equals(certificateDer(b));
}
