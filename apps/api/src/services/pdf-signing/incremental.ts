import { createHash, randomBytes } from 'node:crypto';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, type PDFDocument, type PDFObject } from 'pdf-lib';

// บันทึก PDF แบบต่อท้ายไฟล์ (incremental update, ISO 32000-1 ข้อ 7.5.6) — ระยะ D4
// pdf-lib บันทึกได้แค่เขียนทั้งไฟล์ใหม่ (ลายมือชื่อเดิมเสีย) จึงเขียนเองเฉพาะ object ที่เพิ่ม/เปลี่ยนต่อท้ายไบต์เดิมทุกไบต์
// + ส่วน xref ใหม่ที่ชี้ /Prev ไปส่วนเดิม ในรูปแบบเดียวกับไฟล์ต้นฉบับ (ตาราง หรือ xref stream)

const objectBytes = (obj: PDFObject): Buffer => {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return Buffer.from(out);
};

const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

export type ObjectSnapshot = Map<string, string>;

/**
 * ลายนิ้วมือของทุก object ก่อนแก้ — หลังแก้เทียบเพื่อหา object ที่เพิ่ม/เปลี่ยน (เขียนเฉพาะส่วนนั้น)
 * ผู้เรียกต้องเรียก doc.getPages() ก่อน snapshot: pdf-lib จัดรูป dictionary ของหน้าครั้งแรกที่อ่าน
 * ถ้า snapshot ก่อน จะนับการจัดรูปนั้นเป็นการแก้หน้า (เปลี่ยนหน้าโดยไม่จำเป็น)
 */
export function snapshotObjects(doc: PDFDocument): ObjectSnapshot {
  const snapshot: ObjectSnapshot = new Map();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    snapshot.set(refKey(ref), createHash('sha256').update(objectBytes(obj)).digest('hex'));
  }
  return snapshot;
}

type PreviousSection = { startxref: number; size: number; kind: 'table' | 'stream'; id: PDFHexString | null };

/** ส่วน xref ล่าสุดของไฟล์: ตำแหน่ง (startxref ท้ายไฟล์), /Size, รูปแบบ และ /ID */
function previousSection(original: Buffer): PreviousSection {
  const tail = original.subarray(Math.max(0, original.length - 1024)).toString('latin1');
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!match) throw new Error('ไม่พบ startxref ท้ายไฟล์');
  const startxref = Number(match[1]);
  const head = original.subarray(startxref, startxref + 64).toString('latin1');
  const kind = head.startsWith('xref') ? 'table' : 'stream';
  // trailer ของตาราง อยู่หลังคำว่า trailer / ของ xref stream อยู่ใน dictionary ของ stream
  const region = original.subarray(startxref, Math.min(original.length, startxref + 1024 * 1024)).toString('latin1');
  const dictText = kind === 'table' ? region.slice(region.indexOf('trailer')) : region.slice(0, region.indexOf('stream'));
  const size = /\/Size\s+(\d+)/.exec(dictText);
  if (!size) throw new Error('ไม่พบ /Size ของส่วน xref ล่าสุด');
  const id = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>/.exec(dictText);
  return { startxref, size: Number(size[1]), kind, id: id ? PDFHexString.of(id[1]!) : null };
}

/**
 * เขียนส่วนต่อท้าย: object ที่เพิ่ม/เปลี่ยนจาก snapshot + xref + trailer (/Prev = ส่วนเดิม) — คืนไฟล์ทั้งหมด (ไบต์เดิม + ส่วนใหม่)
 * ไบต์เดิมไม่ถูกแตะเลย ลายมือชื่อเดิมจึงยังครอบคลุมช่วงเดิมได้ถูกต้อง
 */
export function writeIncrementalUpdate(original: Buffer, doc: PDFDocument, snapshot: ObjectSnapshot): Buffer {
  const prev = previousSection(original);
  const { context } = doc;
  const changed = context
    .enumerateIndirectObjects()
    .filter(([ref, obj]) => snapshot.get(refKey(ref)) !== createHash('sha256').update(objectBytes(obj)).digest('hex'))
    .sort(([a], [b]) => a.objectNumber - b.objectNumber);

  const parts: Buffer[] = [];
  // เริ่มบรรทัดใหม่เสมอ (ไฟล์เดิมอาจจบที่ %%EOF โดยไม่มีขึ้นบรรทัด)
  let offset = original.length;
  const push = (chunk: Buffer) => {
    parts.push(chunk);
    offset += chunk.length;
  };
  push(Buffer.from('\n', 'latin1'));

  const entries: { num: number; gen: number; offset: number }[] = [];
  for (const [ref, obj] of changed) {
    entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset });
    push(Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, 'latin1'));
    push(objectBytes(obj));
    push(Buffer.from('\nendobj\n', 'latin1'));
  }

  // /ID: คงค่าแรก (ตัวตนของเอกสาร) เปลี่ยนค่าที่สอง (รุ่นของไฟล์) ตามข้อ 14.4
  const firstId = prev.id ?? PDFHexString.of(randomBytes(16).toString('hex'));
  const root = context.trailerInfo.Root;
  if (!root) throw new Error('ไม่พบ /Root ของไฟล์');
  const trailerDict = (size: number) => {
    const dict = PDFDict.withContext(context);
    dict.set(PDFName.of('Size'), PDFNumber.of(size));
    dict.set(PDFName.of('Root'), root);
    if (context.trailerInfo.Info) dict.set(PDFName.of('Info'), context.trailerInfo.Info);
    dict.set(PDFName.of('ID'), context.obj([firstId, PDFHexString.of(randomBytes(16).toString('hex'))]));
    dict.set(PDFName.of('Prev'), PDFNumber.of(prev.startxref));
    return dict;
  };
  const largest = Math.max(prev.size - 1, ...entries.map((e) => e.num));

  const xrefStart = offset;
  if (prev.kind === 'table') {
    const lines = ['xref'];
    for (const group of consecutive(entries)) {
      lines.push(`${group[0]!.num} ${group.length}`);
      for (const e of group) lines.push(`${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r`);
    }
    push(Buffer.from(`${lines.join('\n')}\ntrailer\n`, 'latin1'));
    push(objectBytes(trailerDict(largest + 1)));
    push(Buffer.from(`\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'));
  } else {
    // ไฟล์ต้นฉบับใช้ xref stream: ส่วนใหม่เป็น xref stream ด้วย (W = [1 4 2], ไม่บีบอัด) รวมตัว stream เองไว้ในตาราง
    const streamNum = largest + 1;
    const all = [...entries, { num: streamNum, gen: 0, offset: xrefStart }];
    const groups = consecutive(all);
    const rows = Buffer.alloc(all.length * 7);
    all.forEach((e, i) => {
      rows.writeUInt8(1, i * 7);
      rows.writeUInt32BE(e.offset, i * 7 + 1);
      rows.writeUInt16BE(e.gen, i * 7 + 5);
    });
    const dict = trailerDict(streamNum + 1);
    dict.set(PDFName.of('Type'), PDFName.of('XRef'));
    dict.set(PDFName.of('Index'), context.obj(groups.flatMap((g) => [g[0]!.num, g.length])));
    dict.set(PDFName.of('W'), context.obj([1, 4, 2]));
    dict.set(PDFName.of('Length'), PDFNumber.of(rows.length));
    push(Buffer.from(`${streamNum} 0 obj\n`, 'latin1'));
    push(objectBytes(dict));
    push(Buffer.from('\nstream\n', 'latin1'));
    push(rows);
    push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'));
  }
  return Buffer.concat([original, ...parts]);
}

/** แบ่งรายการ (เรียงตามเลขแล้ว) เป็นช่วงเลขต่อเนื่อง — แต่ละช่วงคือ 1 ส่วนย่อยของ xref */
function consecutive<T extends { num: number }>(sorted: T[]): T[][] {
  const groups: T[][] = [];
  for (const e of sorted) {
    const last = groups.at(-1);
    if (last && last.at(-1)!.num + 1 === e.num) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

/**
 * สิทธิ์ DocMDP ของเอกสารที่ถูกรับรอง (certified) แล้ว: 1 = ห้ามแก้ไขใด ๆ, 2 = กรอกฟอร์ม/ลงนามได้, 3 = + แก้ annotation
 * null = ไม่ใช่เอกสารที่ถูกรับรอง (อ่านจาก /Perms /DocMDP ของ catalog → /Reference ของลายมือชื่อนั้น, P ไม่ระบุ = 2)
 */
export function docMdpPermission(doc: PDFDocument): number | null {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  const signature = perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict);
  if (!signature) return null;
  const references = signature.lookupMaybe(PDFName.of('Reference'), PDFArray);
  for (let i = 0; i < (references?.size() ?? 0); i++) {
    const reference = references!.lookupMaybe(i, PDFDict);
    if (reference?.lookupMaybe(PDFName.of('TransformMethod'), PDFName)?.asString() !== '/DocMDP') continue;
    const params = reference.lookupMaybe(PDFName.of('TransformParams'), PDFDict);
    return params?.lookupMaybe(PDFName.of('P'), PDFNumber)?.asNumber() ?? 2;
  }
  return 2;
}

/**
 * object ใหม่ต้องได้เลขต่อจาก /Size ของส่วน xref ล่าสุด — เลขที่ต่ำกว่านั้นอาจถูกประกาศว่าว่าง (free) ไว้ด้วย generation อื่น
 * เรียกก่อนเพิ่ม object ใด ๆ (pdf-lib ให้เลขใหม่ = largestObjectNumber + 1)
 */
export function reserveExistingObjectNumbers(original: Buffer, doc: PDFDocument): void {
  const { size } = previousSection(original);
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, size - 1);
}

/**
 * ส่วน xref แรกสุดของไฟล์ (ฉบับที่ลงนามครั้งแรก) เป็นตารางที่แบ่งหลายช่วง = มีเลข object หายตรงกลาง
 * เกิดกับโปรแกรมที่เขียน PDF ใหม่ทั้งไฟล์แล้วไม่เรียงเลข object ใหม่ (เช่น pdf-lib — ระบบนี้เองก่อน PR #31)
 * ลงนามเพิ่มแล้ว Acrobat แสดงลายมือชื่อเดิมของผู้อื่นว่า "altered or corrupted" ทั้งที่ไบต์เดิมไม่เปลี่ยน
 * (ยืนยันกับ Acrobat 2026-10-26) จึงต้องปฏิเสธก่อนลงนาม — ส่วนต่อท้าย (incremental) ที่มีหลายช่วงเป็นเรื่องปกติ ไม่ตรวจ
 * ไล่ /Prev ย้อนไปถึงส่วนแรก ตรวจเฉพาะแบบตาราง (xref stream ยังไม่ได้ทดสอบกับ Acrobat — ไม่ปฏิเสธ)
 */
export function firstRevisionHasXrefGaps(original: Buffer): boolean {
  let offset = previousSection(original).startxref;
  for (let guard = 0; guard < 100; guard++) {
    const region = original.subarray(offset, Math.min(original.length, offset + 4 * 1024 * 1024)).toString('latin1');
    const table = region.startsWith('xref');
    const dictText = table ? region.slice(region.indexOf('trailer'), region.indexOf('startxref')) : region.slice(0, region.indexOf('stream'));
    const prev = /\/Prev\s+(\d+)/.exec(dictText);
    if (prev) {
      offset = Number(prev[1]);
      continue;
    }
    if (!table) return false;
    const subsections = region.slice(0, region.indexOf('trailer')).split('\n').filter((line) => /^\s*\d+\s+\d+\s*$/.test(line));
    return subsections.length > 1;
  }
  return false;
}
