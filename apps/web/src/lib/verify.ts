// ผลการตรวจลายมือชื่อบนเอกสารจาก API POST /verify/pdf — ใช้ได้ทั้ง Server และ Client Component

/** ต้องตรงกับ MAX_PDF_BYTES ของ API (apps/api/src/routes/verify.ts) */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export type Verdict = 'valid' | 'unknown' | 'invalid';

export type Finding = { level: 'error' | 'warning' | 'info'; message: string };

export type CertificateSummary = {
  commonName: string | null;
  organization: string | null;
  email: string | null;
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
};

export type SignatureReport = {
  index: number;
  kind: 'signature' | 'document_timestamp';
  verdict: Verdict;
  findings: Finding[];
  name: string | null;
  reason: string | null;
  location: string | null;
  coversWholeDocument: boolean;
  /** สิ่งที่ต่อท้ายหลังลายมือชื่อ: ltv = ข้อมูลตรวจสอบระยะยาวล้วน (ไม่ใช่การแก้ไข) */
  addedAfter: 'none' | 'ltv' | 'changes';
  integrity: 'ok' | 'failed' | 'unsupported';
  signer: CertificateSummary | null;
  chain: { status: 'trusted' | 'untrusted'; anchor: string | null; path: { subject: string; issuer: string }[] };
  signingTime: { value: string | null; source: 'timestamp' | 'claimed' | 'none' };
  timestamp: { status: 'none' | 'valid' | 'untrusted' | 'invalid'; time: string | null; authority: string | null };
  revocation: { status: 'good' | 'revoked' | 'unknown'; revokedAt: string | null; reason: string | null };
  issuedByUniversity: boolean;
};

export type VerificationReport = {
  verifiedAt: string;
  signatures: SignatureReport[];
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  valid: 'ลายมือชื่อถูกต้อง',
  unknown: 'ไม่ทราบความถูกต้อง',
  invalid: 'ลายมือชื่อไม่ถูกต้อง',
};

export const INTEGRITY_LABELS: Record<SignatureReport['integrity'], string> = {
  ok: 'เอกสารไม่ถูกแก้ไขหลังลงนาม',
  failed: 'เอกสารถูกแก้ไขหรือลายมือชื่อเสียหาย',
  unsupported: 'ตรวจไม่ได้',
};

export const REVOCATION_LABELS: Record<SignatureReport['revocation']['status'], string> = {
  good: 'ยังไม่ถูกเพิกถอน',
  revoked: 'ถูกเพิกถอนแล้ว',
  unknown: 'ตรวจไม่ได้',
};

export const REVOCATION_REASON_LABELS: Record<string, string> = {
  keyCompromise: 'key อาจหลุดไปถึงผู้อื่น',
  CACompromise: 'CA ถูกบุกรุก',
  affiliationChanged: 'ข้อมูลในใบรับรองไม่ถูกต้อง / ย้ายสังกัด',
  superseded: 'ออกใบใหม่แทนแล้ว',
  cessationOfOperation: 'เลิกใช้งาน / พ้นสภาพ',
  unspecified: 'ไม่ระบุ',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
