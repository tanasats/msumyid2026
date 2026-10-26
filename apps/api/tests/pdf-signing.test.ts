import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  docMdpPermission,
  firstRevisionHasXrefGaps,
  reserveExistingObjectNumbers,
  snapshotObjects,
  writeIncrementalUpdate,
} from '../src/services/pdf-signing/incremental.js';
import { PdfSigningError, signPdf, TimestampError } from '../src/services/pdf-signing/index.js';
import { positiveNonce, type TsaTransport } from '../src/services/pdf-signing/timestamp.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { createFakeSigning } from './helpers/fake-signing.js';

// เครื่องมือลงนาม PDF (ระยะ D0): ใช้ OpenSSL จริงแทน signer (key ทดสอบ) และ TSA จำลองด้วย openssl ts
// แล้วตรวจผลด้วยตัวตรวจเดียวกับหน้า /verify — ไม่เรียก signer และ MSU TSA จริง

const { mockSigner, fakeTsa, cleanup } = createFakeSigning();

afterAll(() => {
  cleanup();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const certificate = { serialNumber: '1', certificatePem: '-----BEGIN CERTIFICATE-----', escrow: { kekId: 't', encryptedKey: Buffer.alloc(1), wrappedDataKey: Buffer.alloc(1) } };

async function samplePdf(pages = 2, options: { classicTrailer?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 780, font, size: 14 });
  // classicTrailer = เขียน xref แบบตาราง + trailer (ไม่ใช่ xref stream) ให้แก้ trailer ด้วยข้อความได้
  return Buffer.from(await doc.save({ useObjectStreams: !options.classicTrailer }));
}

const sign = (pdf: Buffer, options: { lock?: boolean; tsa?: TsaTransport } = {}) =>
  signPdf(pdf, { certificate, signerName: 'ผู้ลงนาม ทดสอบ', lock: options.lock ?? false, tsaTransport: options.tsa ?? fakeTsa });

describe('signPdf', () => {
  it('ลงนามแล้ว: ตัวตรวจของ /verify เห็นลายมือชื่อเดียว เอกสารไม่ถูกแก้ ครอบคลุมทั้งไฟล์ และเวลามาจาก timestamp', async () => {
    const send = mockSigner();
    const { pdf, timestampTime } = await sign(await samplePdf());

    expect(send).toHaveBeenCalledOnce();
    // signer ได้เฉพาะข้อมูลตาม ByteRange + ข้อมูลใบ ไม่ได้ทั้งไฟล์
    expect(send.mock.calls[0]![0].content.length).toBeLessThan(pdf.length);

    const report = await verifyPdfSignatures(pdf);
    expect(report.signatures).toHaveLength(1);
    const [s] = report.signatures;
    expect(s).toMatchObject({ kind: 'signature', integrity: 'ok', coversWholeDocument: true, name: 'ผู้ลงนาม ทดสอบ' });
    // มี timestamp และอ่านเวลาได้ตรงกับที่ TSA ตอบ — TSA จำลองไม่ได้ต่อสายถึง CA ที่ระบบเชื่อถือ ตัวตรวจจึงยังใช้เวลาที่อ้าง (/M)
    // (กับ MSU TSA จริง ตัวตรวจได้ timestamp.status = valid และ signingTime.source = timestamp — สคริปต์ pdf:sign-sample)
    expect(s!.timestamp.status).toBe('untrusted');
    expect(s!.timestamp.time).toBe(timestampTime.toISOString());

    // เปิดด้วย pdf-lib ได้ จำนวนหน้าเท่าเดิม และไม่มีการล็อก
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.catalog.get(PDFName.of('Perms'))).toBeUndefined();
  });

  it('ล็อกเอกสาร: มี /Perms /DocMDP (P=1) และแก้ไขต่อท้ายหลังลงนาม → ตัวตรวจเห็นว่าลายมือชื่อไม่ครอบคลุมทั้งไฟล์', async () => {
    mockSigner();
    const { pdf } = await sign(await samplePdf(), { lock: true });
    const doc = await PDFDocument.load(pdf);
    const perms = doc.catalog.lookup(PDFName.of('Perms'), PDFDict);
    const signature = perms.lookup(PDFName.of('DocMDP'), PDFDict);
    expect(signature.get(PDFName.of('Reference'))).toBeDefined();
    expect((await verifyPdfSignatures(pdf)).signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });

    // แก้ไขแบบต่อท้ายไฟล์ (incremental update) หลังลงนาม
    const tampered = Buffer.concat([pdf, Buffer.from('\n1 0 obj\n<< /Tampered true >>\nendobj\n%%EOF\n')]);
    expect((await verifyPdfSignatures(tampered)).signatures[0]!.coversWholeDocument).toBe(false);
  });

  it('ต้นฉบับที่เลข object หายเป็นช่วง (เช่น ไฟล์จาก Word): xref ของไฟล์ที่ลงนามเป็นส่วนย่อยเดียวเริ่มที่ 0 ครบตาม /Size', async () => {
    // object stream ที่ pdf-lib แตกออกตอนอ่านทำให้เลข object หายกลางไฟล์ — xref หลายส่วนย่อยทำให้ Acrobat ถือว่า
    // เอกสารที่ล็อกถูกแก้หลังลงนาม (พบกับไฟล์ Word 2010 บน production 2026-10-25)
    const xrefSubsections = (pdf: Buffer) => {
      const text = pdf.toString('latin1');
      const xref = text.slice(text.lastIndexOf('\nxref\n') + 1, text.lastIndexOf('trailer'));
      const size = Number(/\/Size (\d+)/.exec(text.slice(text.lastIndexOf('trailer')))![1]);
      return { subsections: xref.split('\n').filter((line) => /^\d+ \d+$/.test(line.trim())), size };
    };
    // ต้นฉบับ: ลบ object กลางไฟล์ออก 3 ตัว แล้วบันทึกแบบตาราง xref → มีหลายส่วนย่อย
    const doc = await PDFDocument.load(await samplePdf(3, { classicTrailer: true }));
    const refs = Array.from({ length: 5 }, () => doc.context.register(doc.context.obj({ Unused: true })));
    for (const ref of refs.slice(1, 4)) doc.context.delete(ref);
    for (let i = 0; i < 2; i++) doc.context.register(doc.context.obj({ After: i }));
    const source = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect(xrefSubsections(source).subsections.length).toBeGreaterThan(1);

    mockSigner();
    const { pdf } = await sign(source, { lock: true });
    const { subsections, size } = xrefSubsections(pdf);
    expect(subsections).toEqual([`0 ${size}`]);
    expect((await verifyPdfSignatures(pdf)).signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });
  });

  it('nonce เป็น INTEGER ที่เข้ารหัส DER ถูกต้องเสมอ: บวก และไบต์แรกไม่เป็น 0 (เคยทำให้ TSA ปฏิเสธราว 1 ใน 256 ครั้ง)', () => {
    for (let i = 0; i < 5000; i++) {
      const nonce = positiveNonce();
      expect(nonce).toHaveLength(8);
      expect(nonce[0]).toBeGreaterThanOrEqual(0x01);
      expect(nonce[0]).toBeLessThanOrEqual(0x7f);
    }
  });

  it('TSA ล่ม → TimestampError (ไม่ออกไฟล์ที่ไม่มีเวลา)', async () => {
    mockSigner();
    const down: TsaTransport = async () => {
      throw new TimestampError('เรียกบริการประทับเวลาไม่สำเร็จ');
    };
    await expect(sign(await samplePdf(), { tsa: down })).rejects.toBeInstanceOf(TimestampError);
  });

  it('TSA ตอบคำขออื่น (nonce/hash ไม่ตรง) หรือตอบไม่ใช่ timestamp → TimestampError', async () => {
    mockSigner();
    // ตอบด้วยคำตอบของคำขอเดิมที่บันทึกไว้ (replay)
    let recorded: Buffer | null = null;
    const recorder: TsaTransport = async (query) => (recorded = await fakeTsa(query));
    await sign(await samplePdf(), { tsa: recorder });
    const replay: TsaTransport = async () => recorded!;
    await expect(sign(await samplePdf(), { tsa: replay })).rejects.toThrow(/ไม่ตรง/);

    const garbage: TsaTransport = async () => Buffer.from('<html>error</html>');
    await expect(sign(await samplePdf(), { tsa: garbage })).rejects.toBeInstanceOf(TimestampError);
  });

  it('ไม่ใช่ PDF / ล็อกไว้แล้ว (P=1) / ล็อกไฟล์ที่มีลายมือชื่อแล้ว / เข้ารหัส → PdfSigningError ตามเหตุผล และไม่เรียก signer', async () => {
    const send = mockSigner();
    const reject = async (pdf: Buffer) => {
      const err = await sign(pdf).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PdfSigningError);
      return (err as PdfSigningError).code;
    };
    expect(await reject(Buffer.from('not a pdf'))).toBe('NOT_PDF');

    const { pdf: locked } = await sign(await samplePdf(), { lock: true });
    const { pdf: signed } = await sign(await samplePdf());
    send.mockClear();
    expect(await reject(locked)).toBe('DOCUMENT_LOCKED');
    const lockErr = await sign(signed, { lock: true }).catch((e: unknown) => e);
    expect((lockErr as PdfSigningError).code).toBe('LOCK_NOT_FIRST');

    // trailer ที่มี /Encrypt = ไฟล์ตั้งรหัสผ่าน/จำกัดสิทธิ์
    const classic = (await samplePdf(1, { classicTrailer: true })).toString('latin1');
    expect(classic).toContain('trailer');
    const encrypted = Buffer.from(classic.replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 >>'), 'latin1');
    expect(await reject(encrypted)).toBe('ENCRYPTED');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ลงนามเพิ่มบนไฟล์ที่มีลายมือชื่อแล้ว (incremental update, ระยะ D4a)', () => {
  const xrefSections = (pdf: Buffer) => pdf.toString('latin1').match(/startxref\s+\d+\s+%%EOF/g)?.length ?? 0;

  it('ลงนามคนที่ 2 และ 3: ไบต์เดิมไม่เปลี่ยน ลายมือชื่อเดิมยังผ่าน (ครอบคลุมฉบับก่อน) ลายมือชื่อใหม่ครอบคลุมทั้งไฟล์', async () => {
    mockSigner();
    const { pdf: first } = await sign(await samplePdf(), { lock: false });
    const { pdf: second } = await sign(first);
    expect(second.subarray(0, first.length).equals(first)).toBe(true);
    expect(xrefSections(second)).toBe(xrefSections(first) + 1);

    const third = (
      await signPdf(second, {
        certificate,
        signerName: 'ผู้ลงนามคนที่ 3',
        lock: false,
        tsaTransport: fakeTsa,
        appearance: { page: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.1, image: null, showText: true },
      })
    ).pdf;
    const report = await verifyPdfSignatures(third);
    expect(report.signatures.map((x) => [x.integrity, x.coversWholeDocument, x.name])).toEqual([
      ['ok', false, 'ผู้ลงนาม ทดสอบ'],
      ['ok', false, 'ผู้ลงนาม ทดสอบ'],
      ['ok', true, 'ผู้ลงนามคนที่ 3'],
    ]);
    // ส่วนต่อท้ายต้องไม่แตะเนื้อหาหน้า (/Contents, /Resources) — เปลี่ยนแล้ว Acrobat ถือว่าแก้เนื้อหาหลังลงนาม ลายมือชื่อเดิม invalid
    // (pdf-lib addAnnot ห่อเนื้อหาด้วย q/Q — พบกับ Acrobat 2026-10-26)
    const pageEntries = async (pdf: Buffer) => {
      const node = (await PDFDocument.load(pdf)).getPage(0).node;
      return ['Contents', 'Resources'].map((k) => node.get(PDFName.of(k))?.toString());
    };
    expect(await pageEntries(second)).toEqual(await pageEntries(first));
    expect(await pageEntries(third)).toEqual(await pageEntries(first));
    // pdf-lib อ่านไฟล์หลายส่วนได้: AcroForm มีครบ 3 ช่อง และหน้าแรกมีช่องลายมือชื่อเดิม 2 ช่อง
    const doc = await PDFDocument.load(third);
    const fields = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(3);
  });

  it('เอกสารที่รับรองแบบ P=2 (กรอกฟอร์ม/ลงนามได้) ลงนามเพิ่มได้', async () => {
    mockSigner();
    const { pdf: locked } = await sign(await samplePdf(), { lock: true });
    // แก้ P 1 → P 2 (ความยาวเท่าเดิม ตำแหน่งไบต์ไม่เลื่อน) จำลองเอกสารที่ผู้อื่นรับรองแบบอนุญาตให้ลงนาม
    const p2 = Buffer.from(locked.toString('latin1').replace('/P 1', '/P 2'), 'latin1');
    const { pdf } = await sign(p2);
    expect((await verifyPdfSignatures(pdf)).signatures).toHaveLength(2);
  });

  it('ไฟล์ที่ส่วนล่าสุดเป็น xref stream: ส่วนต่อท้ายเป็น xref stream ด้วย และอ่านได้ครบ', async () => {
    const source = await samplePdf(2);
    expect(source.toString('latin1')).toContain('/Type /XRef');
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    doc.getPages();
    const snapshot = snapshotObjects(doc);
    reserveExistingObjectNumbers(source, doc);
    const added = doc.context.register(doc.context.obj({ Added: true }));
    doc.catalog.set(PDFName.of('Marker'), added);
    const updated = writeIncrementalUpdate(source, doc, snapshot);

    expect(updated.subarray(0, source.length).equals(source)).toBe(true);
    const tail = updated.subarray(source.length).toString('latin1');
    expect(tail).toContain('/Type /XRef');
    expect(tail).toMatch(/\/Prev \d+/);
    const reloaded = await PDFDocument.load(updated);
    expect(reloaded.catalog.lookup(PDFName.of('Marker'), PDFDict).get(PDFName.of('Added'))?.toString()).toBe('true');
    expect(reloaded.getPageCount()).toBe(2);
  });

  it('firstRevisionHasXrefGaps: ฉบับแรกที่ xref หลายช่วง (เช่น ระบบนี้ก่อน PR #31) = true / ไฟล์ที่ระบบลงนามตอนนี้และส่วนต่อท้าย = false', async () => {
    mockSigner();
    // ต้นฉบับที่เลข object หายตรงกลาง บันทึกแบบตาราง xref → หลายช่วง
    const doc = await PDFDocument.load(await samplePdf(2, { classicTrailer: true }));
    const refs = Array.from({ length: 4 }, () => doc.context.register(doc.context.obj({ Unused: true })));
    for (const ref of refs.slice(1, 3)) doc.context.delete(ref);
    doc.context.register(doc.context.obj({ After: true }));
    const gappy = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect(firstRevisionHasXrefGaps(gappy)).toBe(true);

    const { pdf: first } = await sign(gappy);
    expect(firstRevisionHasXrefGaps(first)).toBe(false);
    const { pdf: second } = await sign(first);
    expect(firstRevisionHasXrefGaps(second)).toBe(false);
    // xref stream ยังไม่ได้ทดสอบกับ Acrobat — ไม่ถือว่าเป็นไฟล์รุ่นก่อน
    expect(firstRevisionHasXrefGaps(await samplePdf())).toBe(false);
  });

  it('docMdpPermission: ไม่ได้รับรอง = null / ล็อกของระบบ = 1', async () => {
    mockSigner();
    expect(docMdpPermission(await PDFDocument.load(await samplePdf()))).toBeNull();
    const { pdf } = await sign(await samplePdf(), { lock: true });
    expect(docMdpPermission(await PDFDocument.load(pdf))).toBe(1);
  });
});
