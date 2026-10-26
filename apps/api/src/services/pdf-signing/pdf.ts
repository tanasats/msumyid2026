import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFRef, PDFString } from 'pdf-lib';
import { extractPdfSignatures, isPdf, MAX_SIGNATURES } from '../signature-verification/pdf-signatures.js';
import { buildAppearanceStream, placeAppearance, type AppearanceContent, type AppearancePlacement } from './appearance.js';
import {
  docMdpPermission,
  firstRevisionHasXrefGaps,
  reserveExistingObjectNumbers,
  snapshotObjects,
  writeIncrementalUpdate,
} from './incremental.js';

// เตรียม PDF ให้มีช่องลายมือชื่อ + placeholder แล้วฝัง CMS ที่ได้ — ไม่ถือ key (การลงนามจริงอยู่ที่ signer)
// docs/design/document-signing.md

/** ขนาดที่จองไว้ให้ CMS ใน /Contents (ไบต์) — ใบผู้ลงนาม + สายใบ CA + timestamp token พร้อมสายใบของ TSA ราว 12–16 KB */
export const SIGNATURE_RESERVED_BYTES = 32 * 1024;

const BYTE_RANGE_PLACEHOLDER = '**********';

/** ไฟล์ลงนามไม่ได้ — ผู้เรียกแสดงเป็นความล้มเหลวของไฟล์นั้น (เหตุผลภาษาไทยในข้อความ) */
export class PdfSigningError extends Error {
  constructor(
    public readonly code:
      | 'NOT_PDF'
      | 'ENCRYPTED'
      | 'INVALID_PDF'
      | 'SIGNATURE_TOO_LARGE'
      | 'PAGE_NOT_FOUND'
      | 'DOCUMENT_LOCKED'
      | 'LOCK_NOT_FIRST'
      | 'TOO_MANY_SIGNATURES'
      | 'COSIGN_UNSAFE_STRUCTURE',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfSigningError';
  }
}

export type PrepareOptions = {
  /** ล็อกเอกสาร: certification signature + DocMDP P=1 (ห้ามแก้ไขใด ๆ หลังลงนาม) */
  lock: boolean;
  /** ชื่อผู้ลงนาม (display_name) — ใส่ใน /Name ให้โปรแกรมอ่าน PDF แสดง */
  signerName: string;
  signingTime: Date;
  /** ลายมือชื่อแบบมองเห็น (ภาพ/ข้อความ ณ ตำแหน่งที่เลือก) — ไม่ระบุ = มองไม่เห็นบนหน้าแรก */
  appearance?: AppearancePlacement & AppearanceContent;
};

export type PreparedPdf = {
  pdf: Buffer;
  /** [0, ก่อน /Contents, หลัง /Contents, ถึงท้ายไฟล์] */
  byteRange: [number, number, number, number];
};

/** ลายมือชื่อในไฟล์ได้ไม่เกินเท่านี้ (เท่ากับที่ตัวตรวจของ /verify อ่าน) */
const MAX_EXISTING_SIGNATURES = MAX_SIGNATURES - 1;

/**
 * เพิ่มช่องลายมือชื่อ (มองไม่เห็นบนหน้าแรก หรือมองเห็นตาม options.appearance) + dictionary ลายมือชื่อที่มี placeholder ของ /ByteRange และ /Contents
 * - ไฟล์ที่ยังไม่มีลายมือชื่อ: เขียนทั้งไฟล์ใหม่ (วิธีที่ทดสอบกับ Acrobat แล้ว — ยืนยัน 2026-10-26 ให้คงไว้)
 * - ไฟล์ที่มีลายมือชื่ออยู่แล้ว (ระยะ D4a): เขียนต่อท้ายไฟล์ (incremental update) ไบต์เดิมไม่เปลี่ยน ลายมือชื่อเดิมจึงยังผ่าน
 *   เอกสารที่ล็อกแบบห้ามแก้ไข (DocMDP P=1) ลงนามเพิ่มไม่ได้ และล็อกเพิ่มไม่ได้ (certification ต้องเป็นลายมือชื่อแรก)
 * - บันทึกแบบไม่ใช้ object stream: dictionary ลายมือชื่อต้องเป็นข้อความธรรมดา จึงแก้ /ByteRange ทีหลังได้
 */
export async function preparePdf(input: Buffer, options: PrepareOptions): Promise<PreparedPdf> {
  if (!isPdf(input)) throw new PdfSigningError('NOT_PDF', 'ไฟล์นี้ไม่ใช่ PDF');
  let existing: number;
  try {
    existing = extractPdfSignatures(input).length;
  } catch (err) {
    throw new PdfSigningError('INVALID_PDF', 'อ่านลายมือชื่อเดิมในไฟล์ไม่ได้ ไฟล์อาจเสีย', { cause: err });
  }
  const incremental = existing > 0;
  if (existing > MAX_EXISTING_SIGNATURES) {
    throw new PdfSigningError('TOO_MANY_SIGNATURES', `ไฟล์นี้มีลายมือชื่อครบ ${MAX_SIGNATURES} รายการแล้ว ลงนามเพิ่มไม่ได้`);
  }
  if (incremental && firstRevisionHasXrefGaps(input)) {
    throw new PdfSigningError(
      'COSIGN_UNSAFE_STRUCTURE',
      'ลงนามเพิ่มในไฟล์นี้ไม่ได้: โครงสร้างไฟล์จากโปรแกรมที่ลงนามครั้งแรกทำให้ Acrobat จะแสดงลายมือชื่อเดิมว่าไม่ถูกต้องหลังลงนามเพิ่ม — กรุณาใช้ไฟล์ต้นฉบับที่ยังไม่ลงนาม แล้วให้ทุกคนลงนามตามลำดับในระบบนี้',
    );
  }
  if (incremental && options.lock) {
    throw new PdfSigningError('LOCK_NOT_FIRST', 'ไฟล์นี้มีลายมือชื่ออยู่แล้ว จึงล็อกเอกสารไม่ได้ (ล็อกได้เฉพาะผู้ลงนามคนแรก) — ลงนามโดยไม่ล็อกได้');
  }

  let doc: PDFDocument;
  try {
    // เปิดแบบไม่สนการเข้ารหัสก่อน แล้วตรวจ isEncrypted เอง (pdf-lib แจ้งไฟล์เข้ารหัสเป็น Error ทั่วไป แยกจากไฟล์เสียไม่ได้)
    doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true });
  } catch (err) {
    throw new PdfSigningError('INVALID_PDF', 'เปิดไฟล์ PDF ไม่ได้ ไฟล์อาจเสีย', { cause: err });
  }
  if (doc.isEncrypted) {
    throw new PdfSigningError('ENCRYPTED', 'ไฟล์นี้ตั้งรหัสผ่านหรือจำกัดสิทธิ์ไว้ กรุณาปลดล็อกก่อนลงนาม');
  }
  // getPages ก่อน snapshot: pdf-lib จัดรูป dictionary ของหน้าครั้งแรกที่อ่าน (ไม่นับเป็นการแก้)
  const pages = doc.getPages();
  if (pages.length === 0) throw new PdfSigningError('INVALID_PDF', 'ไฟล์ PDF ไม่มีหน้า');
  if (incremental && docMdpPermission(doc) === 1) {
    throw new PdfSigningError('DOCUMENT_LOCKED', 'เอกสารนี้ถูกล็อกโดยผู้ลงนามคนก่อน (ห้ามแก้ไขใด ๆ) จึงลงนามเพิ่มไม่ได้');
  }
  const snapshot = incremental ? snapshotObjects(doc) : null;
  if (incremental) reserveExistingObjectNumbers(input, doc);
  const page = pages[(options.appearance?.page ?? 1) - 1];
  if (!page) {
    throw new PdfSigningError('PAGE_NOT_FOUND', `ไฟล์นี้มี ${pages.length} หน้า ไม่มีหน้าที่เลือกวางลายเซ็น`);
  }

  const { context, catalog } = doc;
  const signature = context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER), PDFName.of(BYTE_RANGE_PLACEHOLDER)],
    Contents: PDFHexString.of('0'.repeat(SIGNATURE_RESERVED_BYTES * 2)),
    M: PDFString.fromDate(options.signingTime),
    Name: PDFHexString.fromText(options.signerName),
    ...(options.lock
      ? {
          // certification signature: Acrobat แสดง "Certified" และการแก้ไขใด ๆ หลังลงนามทำให้ลายมือชื่อไม่ผ่าน
          Reference: [
            context.obj({
              Type: 'SigRef',
              TransformMethod: 'DocMDP',
              TransformParams: context.obj({ Type: 'TransformParams', P: 1, V: PDFName.of('1.2') }),
            }),
          ],
        }
      : {}),
  });
  const signatureRef = context.register(signature);

  // มองเห็น: Rect ตามตำแหน่งที่เลือก + appearance stream (/AP /N) / มองไม่เห็น: Rect 0
  let rect: [number, number, number, number] = [0, 0, 0, 0];
  let appearanceRef: PDFRef;
  if (options.appearance) {
    const placed = placeAppearance(page, options.appearance);
    rect = placed.rect;
    appearanceRef = await buildAppearanceStream(doc, placed, options.appearance);
  } else {
    // มองไม่เห็นก็ใส่ appearance ว่าง — PDF/A กำหนดให้ annotation ทุกตัวมี /AP (เครื่องมืออื่น เช่น iText ทำแบบเดียวกัน)
    appearanceRef = context.register(context.formXObject([], { BBox: [0, 0, 0, 0] }));
  }

  // F = 132 (Print + Locked) — ผู้อ่านย้าย/ซ่อนช่องลายมือชื่อไม่ได้
  const widget = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    AP: context.obj({ N: appearanceRef }),
    V: signatureRef,
    T: PDFHexString.fromText(`Signature${Date.now()}`),
    F: 132,
    P: page.ref,
  });
  const widgetRef = context.register(widget);
  addAnnotation(page.node, widgetRef);

  addToAcroForm(doc, widgetRef);
  if (options.lock) catalog.set(PDFName.of('Perms'), context.obj({ DocMDP: signatureRef }));

  if (snapshot) {
    // ฝังฟอนต์/ภาพของ appearance ให้เป็น object ก่อนเทียบกับ snapshot (pdf-lib ฝังจริงตอน flush)
    await doc.flush();
    return locatePlaceholders(writeIncrementalUpdate(input, doc, snapshot));
  }
  fillObjectNumberGaps(doc);
  const saved = Buffer.from(await doc.save({ useObjectStreams: false }));
  return locatePlaceholders(saved);
}

/**
 * เติมเลข object ที่ขาดหายด้วย null ให้ตาราง xref เป็นส่วนย่อยเดียวเริ่มจาก 0
 * ไฟล์ที่อ่านมา (เช่น จาก Word) มักมีเลขที่หายไป (object stream / xref stream ที่ pdf-lib แตกออกแล้วไม่ได้เขียนกลับ)
 * pdf-lib จึงเขียน xref หลายส่วนย่อย — ISO 32000-1 ข้อ 7.5.4 กำหนดให้ไฟล์ที่ไม่เคย incremental update มีส่วนย่อยเดียว
 * Acrobat ตีความว่าไฟล์ถูกแก้หลังลงนาม ทำให้เอกสารที่ล็อก (certification) ขึ้นว่าลายมือชื่อไม่ถูกต้อง (ยืนยันกับ Acrobat 2026-10-25)
 */
function fillObjectNumberGaps(doc: PDFDocument): void {
  const { context } = doc;
  const used = new Set(context.enumerateIndirectObjects().map(([ref]) => ref.objectNumber));
  for (let n = 1; n <= context.largestObjectNumber; n++) {
    if (!used.has(n)) context.assign(PDFRef.of(n), PDFNull);
  }
}

/**
 * เพิ่ม widget เข้า /Annots ของหน้าโดยตรง — ไม่ใช้ page.node.addAnnot ของ pdf-lib เพราะมันจัดรูปหน้าก่อน (ห่อเนื้อหาเดิมด้วย q/Q)
 * ซึ่งเปลี่ยน /Contents ของหน้า: ในส่วนต่อท้ายไฟล์ Acrobat นับเป็นการแก้เนื้อหาหลังลงนาม ลายมือชื่อเดิมขึ้นว่า invalid
 * (พบระหว่างทดสอบ D4a กับ Acrobat 2026-10-26)
 */
function addAnnotation(page: PDFDict, ref: PDFRef): void {
  const annots = page.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(ref);
  else page.set(PDFName.of('Annots'), page.context.obj([ref]));
}

/** เพิ่มช่องลายมือชื่อใน AcroForm (สร้างใหม่ถ้ายังไม่มี) — SigFlags 3 = มีลายมือชื่อ + ต้องบันทึกแบบต่อท้ายเท่านั้น */
function addToAcroForm(doc: PDFDocument, widgetRef: PDFRef): void {
  const { context, catalog } = doc;
  let acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!acroForm) {
    acroForm = context.obj({});
    catalog.set(PDFName.of('AcroForm'), context.register(acroForm));
  }
  const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (fields) fields.push(widgetRef);
  else acroForm.set(PDFName.of('Fields'), context.obj([widgetRef]));
  acroForm.set(PDFName.of('SigFlags'), context.obj(3));
}

/** หาตำแหน่ง placeholder ในไฟล์ที่บันทึกแล้ว แล้วเขียน /ByteRange จริง (ความยาวเท่าเดิม ตำแหน่งไบต์จึงไม่เลื่อน) */
function locatePlaceholders(pdf: Buffer): PreparedPdf {
  const text = pdf.toString('latin1');
  const contentsHex = `<${'0'.repeat(SIGNATURE_RESERVED_BYTES * 2)}>`;
  const contentsStart = text.indexOf(contentsHex);
  const rangeMatch = /\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/.exec(text);
  if (contentsStart === -1 || !rangeMatch || text.indexOf(contentsHex, contentsStart + 1) !== -1) {
    throw new PdfSigningError('INVALID_PDF', 'เตรียมช่องลายมือชื่อไม่สำเร็จ');
  }
  const contentsEnd = contentsStart + contentsHex.length;
  const byteRange: PreparedPdf['byteRange'] = [0, contentsStart, contentsEnd, pdf.length - contentsEnd];

  const placeholder = rangeMatch[0];
  const actual = `[0 ${byteRange[1]} ${byteRange[2]} ${byteRange[3]}]`;
  if (actual.length > placeholder.length) throw new PdfSigningError('INVALID_PDF', 'ไฟล์ใหญ่เกินกว่าจะลงนามได้');
  pdf.write(actual.padEnd(placeholder.length, ' '), rangeMatch.index, 'latin1');
  return { pdf, byteRange };
}

/** ข้อมูลที่ต้องลงนาม = ไบต์ตาม /ByteRange ต่อกัน (ทุกส่วนของไฟล์ยกเว้นค่าใน /Contents) */
export function signedContent(prepared: PreparedPdf): Buffer {
  const [a, b, c, d] = prepared.byteRange;
  return Buffer.concat([prepared.pdf.subarray(a, a + b), prepared.pdf.subarray(c, c + d)]);
}

/** ฝัง CMS (DER) ลง /Contents — เติม 0 ให้เต็มช่องที่จองไว้ */
export function embedSignature(prepared: PreparedPdf, cms: Buffer): Buffer {
  if (cms.length > SIGNATURE_RESERVED_BYTES) {
    throw new PdfSigningError('SIGNATURE_TOO_LARGE', 'ลายมือชื่อมีขนาดเกินช่องที่จองไว้');
  }
  const out = Buffer.from(prepared.pdf);
  const hex = cms.toString('hex').padEnd(SIGNATURE_RESERVED_BYTES * 2, '0');
  // ข้าม '<' ที่ตำแหน่งเริ่มของช่อง
  out.write(hex, prepared.byteRange[1] + 1, 'latin1');
  return out;
}
