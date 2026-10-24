import { asn1js, pkijs, toArrayBuffer } from '../signature-verification/pki.js';

// แก้ CMS ที่ signer ออกให้ (ไม่แตะส่วนที่ถูกลงนาม): ดึงค่า signature และเพิ่ม signatureTimeStampToken เป็น unsigned attribute

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_SIGNATURE_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';

function parseSignedData(cms: Buffer): pkijs.SignedData {
  const contentInfo = pkijs.ContentInfo.fromBER(toArrayBuffer(cms));
  if (contentInfo.contentType !== OID_SIGNED_DATA) throw new Error('CMS ไม่ใช่ SignedData');
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });
  if (signedData.signerInfos.length !== 1) throw new Error('CMS ต้องมีผู้ลงนาม 1 คน');
  return signedData;
}

/** ค่า signature ของผู้ลงนาม (ข้อมูลที่ต้องขอ timestamp ตาม RFC 3161 ภาคผนวก A / PAdES B-T) */
export function signatureValue(cms: Buffer): Buffer {
  const signerInfo = parseSignedData(cms).signerInfos[0]!;
  return Buffer.from(signerInfo.signature.valueBlock.valueHexView);
}

/**
 * เพิ่ม timestamp token เป็น unsigned attribute ของผู้ลงนาม — unsigned attribute ไม่อยู่ในส่วนที่ถูกลงนาม
 * ลายมือชื่อเดิมจึงยังถูกต้อง (signedAttrs ถูก encode ซ้ำตามลำดับเดิม — test ตรวจด้วยตัวตรวจของ /verify)
 */
export function addSignatureTimestamp(cms: Buffer, token: Buffer): Buffer {
  const signedData = parseSignedData(cms);
  const signerInfo = signedData.signerInfos[0]!;
  const tokenSchema = asn1js.fromBER(toArrayBuffer(token));
  if (tokenSchema.offset === -1) throw new Error('timestamp token อ่านไม่ได้');
  signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 1,
    attributes: [new pkijs.Attribute({ type: OID_SIGNATURE_TIMESTAMP_TOKEN, values: [tokenSchema.result] })],
  });
  const contentInfo = new pkijs.ContentInfo({ contentType: OID_SIGNED_DATA, content: signedData.toSchema(true) });
  return Buffer.from(contentInfo.toSchema().toBER());
}
