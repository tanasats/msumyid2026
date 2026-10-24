import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';
import { asn1js, pkijs, toArrayBuffer } from '../signature-verification/pki.js';

// ขอประทับเวลา (RFC 3161) จาก MSU TSA แล้วตรวจคำตอบก่อนใช้ — ตัดสินใจ 2026-10-25: TSA ล่ม = ไม่ลงนาม

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

/** ขอ timestamp ไม่สำเร็จหรือคำตอบไม่ถูกต้อง — ผู้เรียกแปลงเป็นความล้มเหลวของไฟล์นั้น (ลองใหม่ได้) */
export class TimestampError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimestampError';
  }
}

/** ส่งคำขอไป TSA — แยกเป็นฟังก์ชันเพื่อให้ test แทนด้วย TSA จำลองได้ */
export type TsaTransport = (query: Buffer) => Promise<Buffer>;

export const httpTsaTransport: TsaTransport = async (query) => {
  let res: Response;
  try {
    res = await fetch(config.tsa.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query' },
      body: new Uint8Array(query),
      signal: AbortSignal.timeout(config.tsa.timeoutMs),
    });
  } catch (err) {
    throw new TimestampError('เรียกบริการประทับเวลาไม่สำเร็จ', { cause: err });
  }
  if (!res.ok) throw new TimestampError(`บริการประทับเวลาตอบ HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

export type TimestampToken = {
  /** ContentInfo (SignedData ของ TSA) แบบ DER — ใส่เป็น signatureTimeStampToken */
  token: Buffer;
  genTime: Date;
};

/** nonce 64 บิตแบบบวก (บิตบนสุดเป็น 0) */
function positiveNonce(): Buffer {
  const nonce = randomBytes(8);
  nonce[0] = nonce[0]! & 0x7f;
  return nonce;
}

const toBuffer = (view: ArrayBuffer | Uint8Array) => Buffer.from(view instanceof Uint8Array ? view : new Uint8Array(view));

/**
 * ขอ timestamp ของข้อมูล (สำหรับลายมือชื่อ PDF = ค่า signature ใน SignerInfo) แล้วตรวจ:
 * สถานะ granted, hash ตรงกับข้อมูลที่ขอ, nonce ตรงกับที่ส่ง — การตรวจลายเซ็นและสายใบของ TSA ทำตอนตรวจไฟล์ทั้งไฟล์ (verifyPdf)
 */
export async function requestTimestamp(data: Buffer, transport: TsaTransport = httpTsaTransport): Promise<TimestampToken> {
  const digest = createHash('sha256').update(data).digest();
  const nonce = positiveNonce();
  const query = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(digest) }),
    }),
    nonce: new asn1js.Integer({ valueHex: toArrayBuffer(nonce) }),
    // ให้ TSA แนบใบของตัวเองใน token — ผู้ตรวจต่อสายได้โดยไม่ต้องหาใบเอง
    certReq: true,
  });

  const reply = await transport(Buffer.from(query.toSchema().toBER()));

  let response: pkijs.TimeStampResp;
  try {
    response = pkijs.TimeStampResp.fromBER(toArrayBuffer(reply));
  } catch (err) {
    throw new TimestampError('คำตอบของบริการประทับเวลาอ่านไม่ได้', { cause: err });
  }
  // 0 = granted, 1 = grantedWithMods
  const status = response.status.status;
  if ((status !== 0 && status !== 1) || !response.timeStampToken) {
    throw new TimestampError(`บริการประทับเวลาปฏิเสธคำขอ (status ${status})`);
  }

  const contentInfo = response.timeStampToken;
  if (contentInfo.contentType !== OID_SIGNED_DATA) throw new TimestampError('token ของบริการประทับเวลาผิดรูปแบบ');
  let tstInfo: pkijs.TSTInfo;
  try {
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const eContent = signedData.encapContentInfo.eContent;
    if (!eContent) throw new Error('ไม่มี TSTInfo');
    tstInfo = pkijs.TSTInfo.fromBER(eContent.getValue());
  } catch (err) {
    throw new TimestampError('token ของบริการประทับเวลาผิดรูปแบบ', { cause: err });
  }

  const imprint = tstInfo.messageImprint;
  if (imprint.hashAlgorithm.algorithmId !== OID_SHA256 || !toBuffer(imprint.hashedMessage.valueBlock.valueHexView).equals(digest)) {
    throw new TimestampError('timestamp ไม่ตรงกับข้อมูลที่ขอ');
  }
  const replyNonce = tstInfo.nonce ? toBuffer(tstInfo.nonce.valueBlock.valueHexView) : null;
  // Integer อาจมีไบต์ 0 นำหน้า — เทียบค่าแบบตัดศูนย์นำหน้า
  const strip = (b: Buffer) => b.subarray(b.findIndex((x) => x !== 0));
  if (!replyNonce || !strip(replyNonce).equals(strip(nonce))) {
    throw new TimestampError('nonce ของ timestamp ไม่ตรงกับที่ส่ง');
  }

  return { token: Buffer.from(contentInfo.toSchema().toBER()), genTime: tstInfo.genTime };
}
