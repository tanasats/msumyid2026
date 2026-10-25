import { signer, type EscrowedKey } from '../signer-client.js';
import { addSignatureTimestamp, signatureValue } from './cms.js';
import { appearanceLines, type AppearancePlacement } from './appearance.js';
import { embedSignature, preparePdf, signedContent } from './pdf.js';
import { httpTsaTransport, requestTimestamp, type TsaTransport } from './timestamp.js';

export { PdfSigningError } from './pdf.js';
export { TimestampError } from './timestamp.js';

// ลงลายมือชื่อดิจิทัลบน PDF: เตรียมช่องลายมือชื่อ → signer ลงนาม CMS ด้วย key สำรอง → ประทับเวลา (MSU TSA) → ฝังลงไฟล์
// ผู้เรียกต้องตรวจสิทธิ์ PIN สถานะใบ และสถานะบัญชีก่อนเสมอ (docs/design/document-signing.md)

export type SigningCertificate = {
  serialNumber: string;
  certificatePem: string;
  escrow: EscrowedKey;
};

export type SignPdfOptions = {
  certificate: SigningCertificate;
  signerName: string;
  lock: boolean;
  /** ลายมือชื่อแบบมองเห็น: ภาพลายเซ็น (PNG) และ/หรือบรรทัด "ลงนามดิจิทัลโดย ..." — ไม่ระบุ = มองไม่เห็น */
  appearance?: AppearancePlacement & { image: Buffer | null; showText: boolean };
  /** แทน TSA จริงได้ใน test */
  tsaTransport?: TsaTransport;
};

export type SignedPdf = { pdf: Buffer; timestampTime: Date };

export async function signPdf(input: Buffer, options: SignPdfOptions): Promise<SignedPdf> {
  const signingTime = new Date();
  const appearance = options.appearance && {
    ...options.appearance,
    // ข้อความใช้เวลาเดียวกับ /M ของลายมือชื่อ (เวลาที่เชื่อถือได้คือ timestamp ที่ฝังในลายมือชื่อ)
    lines: options.appearance.showText ? appearanceLines(options.signerName, signingTime) : null,
  };
  const prepared = await preparePdf(input, { lock: options.lock, signerName: options.signerName, signingTime, appearance });
  const cms = await signer.signCms({ ...options.certificate, content: signedContent(prepared) });
  // ประทับเวลาบนค่า signature (PAdES B-T) — ล้มเหลว = throw TimestampError ไม่ออกไฟล์ที่ไม่มีเวลา
  const timestamp = await requestTimestamp(signatureValue(cms), options.tsaTransport ?? httpTsaTransport);
  return { pdf: embedSignature(prepared, addSignatureTimestamp(cms, timestamp.token)), timestampTime: timestamp.genTime };
}
