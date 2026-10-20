import { createHash, webcrypto } from 'node:crypto';
import { asn1js, pkijs, toArrayBuffer } from '../../src/services/signature-verification/pki.js';

// สร้าง PKI ปลอมและ PDF ที่ลงนามจริงสำหรับ test ของการตรวจลายมือชื่อ (ไม่ต้องเก็บไฟล์ PDF ใน repo)

const subtle = webcrypto.subtle;
const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export type TestCertificate = { certificate: pkijs.Certificate; privateKey: CryptoKey };

type CertificateOptions = {
  commonName: string;
  organization?: string;
  email?: string;
  issuer?: TestCertificate;
  isCa?: boolean;
  serial?: number;
  notBefore?: Date;
  notAfter?: Date;
  extKeyUsage?: string[];
};

let nextSerial = 0x1000;

export async function createTestCertificate(options: CertificateOptions): Promise<TestCertificate> {
  const keys = (await subtle.generateKey(
    { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  const serial = options.serial ?? nextSerial++;
  certificate.serialNumber = new asn1js.Integer({ value: serial });
  setName(certificate.subject, options);
  setName(certificate.issuer, options.issuer ? undefined : options);
  if (options.issuer) {
    certificate.issuer.typesAndValues = options.issuer.certificate.subject.typesAndValues;
  }
  certificate.notBefore.value = options.notBefore ?? new Date(Date.now() - 5 * 365 * 24 * 3600_000);
  certificate.notAfter.value = options.notAfter ?? new Date(Date.now() + 365 * 24 * 3600_000);

  const extensions: pkijs.Extension[] = [];
  const basic = new pkijs.BasicConstraints({ cA: options.isCa ?? false });
  extensions.push(
    new pkijs.Extension({ extnID: '2.5.29.19', critical: true, extnValue: basic.toSchema().toBER(false), parsedValue: basic }),
  );
  // keyUsage: CA = keyCertSign + cRLSign, ผู้ลงนาม = digitalSignature + nonRepudiation
  const usage = new Uint8Array([options.isCa ? 0x06 : 0xc0]);
  const keyUsage = new asn1js.BitString({ valueHex: usage.buffer, unusedBits: options.isCa ? 1 : 6 });
  extensions.push(
    new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: keyUsage.toBER(false), parsedValue: keyUsage }),
  );
  if (options.extKeyUsage) {
    const eku = new pkijs.ExtKeyUsage({ keyPurposes: options.extKeyUsage });
    extensions.push(
      new pkijs.Extension({ extnID: '2.5.29.37', critical: false, extnValue: eku.toSchema().toBER(false), parsedValue: eku }),
    );
  }
  certificate.extensions = extensions;

  await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
  await certificate.sign(options.issuer?.privateKey ?? keys.privateKey, 'SHA-256');
  return { certificate, privateKey: keys.privateKey };
}

function setName(name: pkijs.RelativeDistinguishedNames, options?: CertificateOptions): void {
  if (!options) return;
  const add = (type: string, value: string) =>
    name.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type, value: new asn1js.Utf8String({ value }) }));
  add('2.5.4.6', 'TH');
  if (options.organization) add('2.5.4.10', options.organization);
  add('2.5.4.3', options.commonName);
  if (options.email) {
    name.typesAndValues.push(
      new pkijs.AttributeTypeAndValue({ type: '1.2.840.113549.1.9.1', value: new asn1js.IA5String({ value: options.email }) }),
    );
  }
}

export function serialOf(certificate: pkijs.Certificate): string {
  return Buffer.from(certificate.serialNumber.valueBlock.valueHexView).toString('hex').replace(/^0+/, '') || '0';
}

export function pemOf(certificate: pkijs.Certificate): string {
  const base64 = Buffer.from(certificate.toSchema().toBER(false)).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export function fingerprintOf(certificate: pkijs.Certificate): string {
  return createHash('sha256').update(Buffer.from(certificate.toSchema().toBER(false))).digest('hex');
}

type SignOptions = {
  signer: TestCertificate;
  /** ใบกลางที่แนบในลายมือชื่อ */
  chain?: pkijs.Certificate[];
  signingTime?: Date;
  /** ประทับเวลาด้วย TSA นี้ */
  timestamp?: { tsa: TestCertificate; time: Date; chain?: pkijs.Certificate[] };
  reason?: string;
};

const CONTENTS_HEX_LENGTH = 32768;
const BYTE_RANGE_PLACEHOLDER = '/ByteRange [0 0000000000 0000000000 0000000000]';

/** PDF ขั้นต่ำ + dictionary ลายมือชื่อ แล้วลงนามแบบ PAdES (ETSI.CAdES.detached) */
export async function createSignedPdf(options: SignOptions, base?: Buffer): Promise<Buffer> {
  const prefix = base ?? Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n', 'latin1');
  const objectNumber = 10 + (base ? countSignatures(base) : 0);
  const reason = options.reason ? ` /Reason <${utf16Hex(options.reason)}>` : '';
  const head = `${objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /Name (Test Signer)${reason} /M (D:20261016120000+07'00') ${BYTE_RANGE_PLACEHOLDER} /Contents <`;
  const tail = `> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const pdf = Buffer.concat([
    prefix,
    Buffer.from(head, 'latin1'),
    Buffer.alloc(CONTENTS_HEX_LENGTH, '0'),
    Buffer.from(tail, 'latin1'),
  ]);

  const gapStart = prefix.length + head.length - 1; // ตำแหน่ง '<'
  const gapEnd = gapStart + 1 + CONTENTS_HEX_LENGTH + 1; // หลัง '>'
  const byteRange = [0, gapStart, gapEnd, pdf.length - gapEnd];
  const rangeText = `/ByteRange [${byteRange.join(' ')}]`.padEnd(BYTE_RANGE_PLACEHOLDER.length, ' ');
  const rangeOffset = pdf.indexOf(BYTE_RANGE_PLACEHOLDER, prefix.length, 'latin1');
  pdf.write(rangeText, rangeOffset, 'latin1');

  const signedBytes = Buffer.concat([pdf.subarray(0, gapStart), pdf.subarray(gapEnd)]);
  const cms = await createCms(signedBytes, options);
  const hex = cms.toString('hex');
  if (hex.length > CONTENTS_HEX_LENGTH) throw new Error('CMS ใหญ่เกินช่อง /Contents');
  pdf.write(hex, gapStart + 1, 'latin1');
  return pdf;
}

function countSignatures(pdf: Buffer): number {
  return pdf.toString('latin1').split('/ByteRange').length - 1;
}

function utf16Hex(text: string): string {
  const le = Buffer.from(text, 'utf16le');
  le.swap16();
  return `FEFF${le.toString('hex').toUpperCase()}`;
}

async function createCms(data: Buffer, options: SignOptions): Promise<Buffer> {
  const { certificate, privateKey } = options.signer;
  const digest = createHash('sha256').update(data).digest();
  const attributes = [
    new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
    new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: toArrayBuffer(digest) })] }),
  ];
  if (options.signingTime) {
    attributes.push(new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: options.signingTime })] }));
  }
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: certificate.issuer, serialNumber: certificate.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
      }),
    ],
    certificates: [certificate, ...(options.chain ?? [])],
  });
  await signedData.sign(privateKey, 0, 'SHA-256');

  if (options.timestamp) {
    const signerInfo = signedData.signerInfos[0]!;
    const signatureValue = Buffer.from(signerInfo.signature.valueBlock.valueHexView);
    const token = await createTimestampToken(signatureValue, options.timestamp);
    signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: '1.2.840.113549.1.9.16.2.14', values: [token] })],
    });
  }

  const contentInfo = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signedData.toSchema(true) });
  return Buffer.from(contentInfo.toSchema().toBER(false));
}

async function createTimestampToken(
  data: Buffer,
  { tsa, time, chain }: NonNullable<SignOptions['timestamp']>,
): Promise<asn1js.Sequence> {
  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: '1.2.3.4.1',
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(createHash('sha256').update(data).digest()) }),
    }),
    serialNumber: new asn1js.Integer({ value: 1 }),
    genTime: time,
  });
  const tstDer = Buffer.from(tstInfo.toSchema().toBER(false));
  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: '1.2.840.113549.1.9.16.1.4',
      eContent: new asn1js.OctetString({ valueHex: toArrayBuffer(tstDer) }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: tsa.certificate.issuer, serialNumber: tsa.certificate.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.9.16.1.4' })] }),
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.4',
              values: [new asn1js.OctetString({ valueHex: toArrayBuffer(createHash('sha256').update(tstDer).digest()) })],
            }),
          ],
        }),
      }),
    ],
    certificates: [tsa.certificate, ...(chain ?? [])],
  });
  await signedData.sign(tsa.privateKey, 0, 'SHA-256');
  return new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signedData.toSchema(true) }).toSchema();
}
