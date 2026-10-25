import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { appearanceLines, placeAppearance } from '../src/services/pdf-signing/appearance.js';
import { PdfSigningError, signPdf } from '../src/services/pdf-signing/index.js';
import { pngSize } from '../src/services/signature-image-service.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { createFakeSigning } from './helpers/fake-signing.js';
import { solidPng } from './helpers/png.js';

// ลายมือชื่อแบบมองเห็น (ระยะ D2): ตำแหน่งบนหน้าที่หมุน/มี CropBox, ภาพ + ข้อความไทย, ไฟล์ยังตรวจผ่าน

const { mockSigner, fakeTsa, cleanup } = createFakeSigning();

afterAll(() => cleanup());
afterEach(() => vi.restoreAllMocks());

const certificate = { serialNumber: '1', certificatePem: 'x', escrow: { kekId: 't', encryptedKey: Buffer.alloc(1), wrappedDataKey: Buffer.alloc(1) } };

async function pagePdf(options: { rotate?: number; crop?: [number, number, number, number]; pages?: number } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (options.pages ?? 1); i++) {
    const page = doc.addPage([600, 800]);
    page.drawText(`Page ${i + 1}`, { x: 50, y: 750, font, size: 14 });
    if (options.rotate) page.setRotation(degrees(options.rotate));
    if (options.crop) page.setCropBox(...options.crop);
  }
  return doc;
}

const box = { page: 1, x: 0.5, y: 0.75, w: 0.25, h: 0.1 };

describe('placeAppearance', () => {
  it('หน้าไม่หมุน: มุมซ้ายบนของกล่อง = (x·W, H − y·H) และขนาดเท่ากล่อง', async () => {
    const doc = await pagePdf();
    const placed = placeAppearance(doc.getPage(0), box);
    expect(placed.rect).toEqual([300, 120, 450, 200]);
    expect(placed).toMatchObject({ width: 150, height: 80, matrix: [1, 0, 0, 1, 0, 0] });
  });

  it('หน้าหมุน 90/180/270: กล่องที่แสดงผลแปลงเป็น Rect ที่ถูกตำแหน่ง และหมุนเนื้อหาให้ตั้งตรง', async () => {
    // แสดงผลแนวนอน 800×600 เมื่อหมุน 90/270
    const r90 = placeAppearance((await pagePdf({ rotate: 90 })).getPage(0), box);
    expect(r90.rect).toEqual([450, 400, 510, 600]);
    expect(r90).toMatchObject({ width: 200, height: 60, matrix: [0, 1, -1, 0, 0, 0] });

    const r180 = placeAppearance((await pagePdf({ rotate: 180 })).getPage(0), box);
    expect(r180.rect).toEqual([150, 600, 300, 680]);
    expect(r180.matrix).toEqual([-1, 0, 0, -1, 0, 0]);

    const r270 = placeAppearance((await pagePdf({ rotate: 270 })).getPage(0), box);
    expect(r270.rect).toEqual([90, 200, 150, 400]);
    expect(r270.matrix).toEqual([0, -1, 1, 0, 0, 0]);
  });

  it('CropBox: อิงกรอบที่แสดงผล ไม่ใช่ MediaBox', async () => {
    const doc = await pagePdf({ crop: [100, 100, 400, 600] });
    expect(placeAppearance(doc.getPage(0), { page: 1, x: 0, y: 0, w: 0.5, h: 0.5 }).rect).toEqual([100, 400, 300, 700]);
  });
});

describe('appearanceLines', () => {
  it('ชื่อ + วันเวลาไทย พ.ศ. เวลา 24 ชั่วโมง', () => {
    // 2026-10-25 07:05 UTC = 14:05 น. เวลาไทย
    expect(appearanceLines('สมชาย ใจดี', new Date('2026-10-25T07:05:00Z'))).toEqual(['ลงนามดิจิทัลโดย สมชาย ใจดี', '25 ต.ค. 2569 14:05 น.']);
  });
});

describe('signPdf แบบมองเห็น', () => {
  const sign = (pdf: Buffer, appearance: Parameters<typeof signPdf>[1]['appearance'], lock = false) =>
    signPdf(pdf, { certificate, signerName: 'สมชาย ใจดี', lock, appearance, tsaTransport: fakeTsa });

  async function widgetOf(pdf: Buffer, pageIndex: number) {
    const doc = await PDFDocument.load(pdf);
    const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const widget = annots ? (annots.lookup(annots.size() - 1, PDFDict) as PDFDict) : null;
    return { doc, widget };
  }

  it('ภาพ + ข้อความบนหน้าที่เลือก: มี /AP ที่ฝังภาพและฟอนต์ Sarabun, Rect ตรงตำแหน่ง, ลายมือชื่อยังตรวจผ่าน', async () => {
    mockSigner();
    const source = Buffer.from(await (await pagePdf({ pages: 2 })).save());
    const { pdf } = await sign(source, { ...box, page: 2, image: solidPng(300, 120), showText: true }, true);

    const report = await verifyPdfSignatures(pdf);
    expect(report.signatures).toHaveLength(1);
    expect(report.signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });

    const { doc, widget } = await widgetOf(pdf, 1);
    expect(widget).not.toBeNull();
    expect(widget!.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber())).toEqual([300, 120, 450, 200]);
    const ap = widget!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
    const resources = ap.dict.lookup(PDFName.of('Resources'), PDFDict);
    expect(resources.lookup(PDFName.of('XObject'), PDFDict).has(PDFName.of('Img'))).toBe(true);
    const font = resources.lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F'), PDFDict);
    expect(font.lookup(PDFName.of('BaseFont'), PDFName).asString()).toContain('Sarabun');
    // หน้าแรกไม่มีช่องลายมือชื่อ
    expect(doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0).toBe(0);
  });

  it('ข้อความอย่างเดียว (ยังไม่ตั้งภาพ) / ภาพอย่างเดียว (ปิดข้อความ)', async () => {
    mockSigner();
    const source = Buffer.from(await (await pagePdf()).save());

    const textOnly = await widgetOf((await sign(source, { ...box, image: null, showText: true })).pdf, 0);
    const textRes = textOnly.widget!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream).dict.lookup(PDFName.of('Resources'), PDFDict);
    expect(textRes.has(PDFName.of('Font'))).toBe(true);
    expect(textRes.has(PDFName.of('XObject'))).toBe(false);

    const imageOnly = await widgetOf((await sign(source, { ...box, image: solidPng(40, 40), showText: false })).pdf, 0);
    const imageRes = imageOnly.widget!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream).dict.lookup(PDFName.of('Resources'), PDFDict);
    expect(imageRes.has(PDFName.of('Font'))).toBe(false);
    expect(imageRes.has(PDFName.of('XObject'))).toBe(true);
  });

  it('หน้าที่เลือกไม่มีในไฟล์ → PAGE_NOT_FOUND', async () => {
    mockSigner();
    const source = Buffer.from(await (await pagePdf()).save());
    const err = await sign(source, { ...box, page: 3, image: null, showText: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfSigningError);
    expect((err as PdfSigningError).code).toBe('PAGE_NOT_FOUND');
  });
});

describe('pngSize', () => {
  it('อ่านขนาดจาก IHDR / ไม่ใช่ PNG = null', () => {
    expect(pngSize(solidPng(321, 123))).toEqual({ width: 321, height: 123 });
    expect(pngSize(Buffer.from('GIF89a................'))).toBeNull();
  });
});
