import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import { reserveExistingObjectNumbers, snapshotObjects, writeIncrementalUpdate } from './incremental.js';

// LTV (PAdES B-LT, ระยะ D4b): ฝังใบรับรองในสายใบ + CRL ไว้ใน Document Security Store (/DSS ของ catalog, ISO 32000-2 ข้อ 12.8.4.3)
// เขียนต่อท้ายไฟล์หลังลงนาม — ลายมือชื่อไม่เปลี่ยน และโปรแกรมอ่าน PDF ตรวจสถานะใบได้แม้ใบหมดอายุหรือออฟไลน์
// ไม่ใส่ /VRI และ /Extensions /ESIC — Acrobat ขึ้น "LTV enabled" ได้โดยไม่ต้องมี (ทดสอบ 2026-10-26)
// ห้ามใช้กับเอกสารที่ล็อก (DocMDP P=1): Acrobat ถือว่า DSS ที่ต่อท้ายเป็นการแก้ไข แม้ใส่ ESIC/VRI แล้วก็ตาม (ทดสอบ 2026-10-26)

export type RevocationMaterial = {
  /** ใบรับรองแบบ DER: ผู้ลงนาม, TSA และ CA ในสายใบ */
  certs: Buffer[];
  /** CRL แบบ DER ของ CA ทุกใบที่ออกใบในสาย */
  crls: Buffer[];
};

/** ต่อท้าย DSS — ไฟล์ที่มี DSS อยู่แล้ว (ผู้ลงนามก่อนหน้า) เพิ่มต่อในรายการเดิม */
export async function appendDss(pdf: Buffer, material: RevocationMaterial): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  // getPages ก่อน snapshot: pdf-lib จัดรูป dictionary ของหน้าครั้งแรกที่อ่าน (ไม่นับเป็นการแก้)
  doc.getPages();
  const snapshot = snapshotObjects(doc);
  reserveExistingObjectNumbers(pdf, doc);
  const { context, catalog } = doc;

  let dss = catalog.lookupMaybe(PDFName.of('DSS'), PDFDict);
  if (!dss) {
    dss = context.obj({});
    catalog.set(PDFName.of('DSS'), context.register(dss));
  }
  const append = (key: 'Certs' | 'CRLs', items: Buffer[]) => {
    if (items.length === 0) return;
    const refs: PDFRef[] = items.map((der) => context.register(context.flateStream(der)));
    const existing = dss!.lookupMaybe(PDFName.of(key), PDFArray);
    if (existing) refs.forEach((ref) => existing.push(ref));
    else dss!.set(PDFName.of(key), context.obj(refs));
  };
  append('Certs', material.certs);
  append('CRLs', material.crls);
  return writeIncrementalUpdate(pdf, doc, snapshot);
}
