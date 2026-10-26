import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';
import { docMdpPermission } from '../pdf-signing/incremental.js';

// ส่วนที่ต่อท้ายหลังลายมือชื่อ (incremental update) เป็นข้อมูล LTV ล้วนหรือไม่ — ระยะ D4b
// DSS (ใบรับรอง + CRL) ไม่นับเป็นการแก้ไขเอกสาร (ISO 32000-2 / PAdES) ตัวตรวจจึงไม่ควรเตือนว่าเอกสารถูกแก้หลังลงนาม

const MAX_DEPTH = 6;

const bytesOf = (obj: PDFObject) => {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return Buffer.from(out);
};

/** ref ทั้งหมดที่เข้าถึงได้จาก object นี้ (ไล่ dict/array ไม่เกิน MAX_DEPTH ชั้น) */
function reachable(doc: PDFDocument, root: PDFObject | undefined, found = new Set<string>(), depth = 0): Set<string> {
  if (!root || depth > MAX_DEPTH) return found;
  if (root instanceof PDFRef) {
    const key = root.toString();
    if (found.has(key)) return found;
    found.add(key);
    return reachable(doc, doc.context.lookup(root), found, depth + 1);
  }
  const dict = root instanceof PDFStream ? root.dict : root instanceof PDFDict ? root : null;
  if (dict) for (const [, value] of dict.entries()) reachable(doc, value, found, depth + 1);
  if (root instanceof PDFArray) for (const value of root.asArray()) reachable(doc, value, found, depth + 1);
  return found;
}

/**
 * ทุกสิ่งที่เพิ่ม/เปลี่ยนหลังไบต์ที่ end (ท้ายฉบับที่ลงนาม) เป็นข้อมูล LTV ล้วน:
 * object เดิมที่เปลี่ยนมีได้เฉพาะ catalog (ต่างแค่ /DSS) และ object ใน DSS เดิม, object ใหม่ต้องอยู่ใน DSS เท่านั้น
 * อ่านไม่ได้ = ไม่ใช่ (ให้ผู้เรียกแสดงคำเตือนแบบเดิม)
 */
export async function onlyLtvAddedAfter(pdf: Buffer, end: number): Promise<boolean> {
  try {
    const before = await PDFDocument.load(pdf.subarray(0, end), { updateMetadata: false });
    const after = await PDFDocument.load(pdf, { updateMetadata: false });
    const dss = after.catalog.get(PDFName.of('DSS'));
    if (!dss) return false;
    const dssRefs = reachable(after, dss);
    const catalogRef = after.context.trailerInfo.Root;
    if (!(catalogRef instanceof PDFRef) || catalogRef.toString() !== before.context.trailerInfo.Root?.toString()) return false;

    for (const [ref, obj] of after.context.enumerateIndirectObjects()) {
      const key = ref.toString();
      const old = before.context.lookup(ref);
      if (old && bytesOf(old).equals(bytesOf(obj))) continue;
      if (dssRefs.has(key)) continue;
      if (key !== catalogRef.toString() || !old) return false;
      // catalog: ต่างจากเดิมได้เฉพาะ /DSS
      const oldDict = old as PDFDict;
      const newDict = obj as PDFDict;
      const keys = new Set([...oldDict.keys(), ...newDict.keys()].map((k) => k.asString()));
      for (const k of keys) {
        if (k === '/DSS') continue;
        const a = oldDict.get(PDFName.of(k.slice(1)));
        const b = newDict.get(PDFName.of(k.slice(1)));
        if (!a || !b || !bytesOf(a).equals(bytesOf(b))) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * ลายมือชื่อนี้คือลายมือชื่อที่ล็อกเอกสารแบบห้ามแก้ไข (/Perms /DocMDP ของฉบับที่ลงนาม ชี้มาที่ลายมือชื่อนี้ และ P=1)
 * อ่านจากฉบับที่ลงนาม (ไบต์ถึงท้าย ByteRange) — อ่านไม่ได้ = ไม่ใช่
 */
export async function lockedNoChanges(pdf: Buffer, signature: { byteRange: [number, number, number, number] }): Promise<boolean> {
  const end = signature.byteRange[2] + signature.byteRange[3];
  try {
    const doc = await PDFDocument.load(pdf.subarray(0, end), { updateMetadata: false });
    const signatureDict = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict)?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
    const range = signatureDict?.lookupMaybe(PDFName.of('ByteRange'), PDFArray)?.asArray().map((n) => Number(n.toString()));
    if (!range || range.join() !== signature.byteRange.join()) return false;
    return docMdpPermission(doc) === 1;
  } catch {
    return false;
  }
}
