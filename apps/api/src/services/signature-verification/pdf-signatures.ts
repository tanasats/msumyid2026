// แยกลายมือชื่อดิจิทัลออกจากไฟล์ PDF โดยไม่ตีความโครงสร้าง PDF ทั้งไฟล์
// อาศัยกติกาของ PDF (ISO 32000): dictionary ของลายมือชื่อมี /ByteRange [a b c d] ที่บอกช่วงไบต์ที่ถูกลงนาม
// และ "ช่องว่าง" ระหว่างช่วง (b ถึง c) ต้องเป็น /Contents <hex> พอดี — dictionary นี้จึงอยู่ใน object stream ที่บีบอัดไม่ได้

export const MAX_SIGNATURES = 20;

export type PdfSignature = {
  /** ลำดับตามตำแหน่งที่ลงนาม (ลายมือชื่อแรกของเอกสาร = 0) */
  index: number;
  byteRange: [number, number, number, number];
  /** CMS (DER) จาก /Contents ตัดเลข 0 ที่เติมท้ายออกแล้ว */
  cms: Buffer;
  /** ข้อมูลที่ถูกลงนาม = ไบต์ตาม ByteRange ต่อกัน */
  signedData: Buffer;
  subFilter: string | null;
  /** ช่วงที่ลงนามครอบคลุมถึงท้ายไฟล์ (ไม่มีการแก้ไข/ต่อท้ายหลังลงนาม) */
  coversWholeDocument: boolean;
  /** ข้อมูลที่ผู้ลงนามกรอก (ไม่ได้รับรองโดยลายมือชื่อแยกต่างหาก แต่อยู่ในช่วงที่ลงนาม) */
  name: string | null;
  reason: string | null;
  location: string | null;
  /** เวลาที่โปรแกรมของผู้ลงนามระบุใน /M (เชื่อถือไม่ได้ถ้าไม่มีการประทับเวลา) */
  claimedTime: Date | null;
};

export class PdfFormatError extends Error {}

/** ไฟล์ PDF ต้องมี %PDF- ภายใน 1024 ไบต์แรก (Acrobat ยอมให้มีข้อมูลนำหน้าได้) */
export function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes('%PDF-');
}

const BYTE_RANGE_RE = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

export function extractPdfSignatures(buffer: Buffer): PdfSignature[] {
  // latin1 = 1 ไบต์ต่อ 1 ตัวอักษร ตำแหน่งในสตริงจึงตรงกับตำแหน่งไบต์
  const text = buffer.toString('latin1');
  const found: Omit<PdfSignature, 'index'>[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(BYTE_RANGE_RE)) {
    const range = match.slice(1, 5).map(Number) as [number, number, number, number];
    const key = range.join(' ');
    if (seen.has(key)) continue;

    const signature = readSignature(buffer, text, range, match.index);
    if (!signature) continue;
    seen.add(key);
    found.push(signature);
    if (found.length > MAX_SIGNATURES) {
      throw new PdfFormatError(`ลายมือชื่อมากกว่า ${MAX_SIGNATURES} รายการ`);
    }
  }

  return found
    .sort((x, y) => x.byteRange[2] + x.byteRange[3] - (y.byteRange[2] + y.byteRange[3]))
    .map((signature, index) => ({ index, ...signature }));
}

function readSignature(
  buffer: Buffer,
  text: string,
  [a, b, c, d]: [number, number, number, number],
  byteRangeOffset: number,
): Omit<PdfSignature, 'index'> | null {
  // ช่วงต้องเริ่มที่ต้นไฟล์ และช่องว่างต้องอยู่ในไฟล์จริง
  if (a !== 0 || b <= 0 || c <= b + 1 || c + d > buffer.length) return null;
  // ช่องว่างต้องเป็น <hex> พอดี
  if (buffer[b] !== 0x3c || buffer[c - 1] !== 0x3e) return null;
  // /ByteRange ต้องอยู่ในส่วนที่ถูกลงนาม ไม่เช่นนั้นผู้แก้ไฟล์ภายหลังปลอมช่วงได้
  const insideSigned = byteRangeOffset < b || (byteRangeOffset >= c && byteRangeOffset < c + d);
  if (!insideSigned) return null;

  const hex = text.slice(b + 1, c - 1).replace(/[\s]/g, '');
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const cms = trimDer(Buffer.from(hex, 'hex'));
  if (!cms) return null;

  const dict = signatureDictionary(text, byteRangeOffset, b, c);
  return {
    byteRange: [a, b, c, d],
    cms,
    signedData: Buffer.concat([buffer.subarray(a, a + b), buffer.subarray(c, c + d)]),
    subFilter: readName(dict, 'SubFilter'),
    coversWholeDocument: onlyWhitespaceAfter(buffer, c + d),
    name: readString(dict, 'Name'),
    reason: readString(dict, 'Reason'),
    location: readString(dict, 'Location'),
    claimedTime: parsePdfDate(readString(dict, 'M')),
  };
}

/** /Contents เติม 0 ท้ายจนเต็มช่อง — ตัดให้เหลือเท่าความยาวของ DER ตัวแรก (SEQUENCE) */
function trimDer(bytes: Buffer): Buffer | null {
  if (bytes.length < 2 || bytes[0] !== 0x30) return null;
  const first = bytes[1]!;
  let length: number;
  let header: number;
  if (first < 0x80) {
    length = first;
    header = 2;
  } else {
    const count = first & 0x7f;
    // ความยาวแบบไม่จำกัด (BER indefinite) หรือยาวเกิน 4 ไบต์ — ส่งต่อทั้งก้อนให้ตัวแยก ASN.1 ตัดสิน
    if (count === 0 || count > 4) return bytes;
    if (bytes.length < 2 + count) return null;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[2 + i]!;
    header = 2 + count;
  }
  if (header + length > bytes.length) return null;
  return bytes.subarray(0, header + length);
}

function onlyWhitespaceAfter(buffer: Buffer, end: number): boolean {
  for (let i = end; i < buffer.length; i++) {
    if (!WHITESPACE.has(buffer[i]!)) return false;
  }
  return true;
}

/**
 * ข้อความของ dictionary ลายมือชื่อโดยประมาณ: จาก "obj" ก่อน /ByteRange ถึง "endobj" ถัดไป ตัด /Contents ออก
 * ใช้อ่านค่าประกอบ (ชื่อ, เหตุผล, เวลา) เท่านั้น ผลการตรวจไม่ขึ้นกับค่าเหล่านี้
 */
function signatureDictionary(text: string, offset: number, gapStart: number, gapEnd: number): string {
  const from = Math.max(text.lastIndexOf(' obj', offset), offset - 4096, 0);
  const endObj = text.indexOf('endobj', offset);
  // เผื่อความยาวของ /Contents ด้วย — ลายมือชื่อที่จองช่องไว้ใหญ่ (เช่น 32 KB = 64K ตัวอักษร hex) มีคีย์อื่นต่อท้ายช่องนั้น
  const gap = gapEnd > offset ? gapEnd - gapStart : 0;
  const to = endObj === -1 ? Math.min(offset + 4096 + gap, text.length) : Math.min(endObj, offset + 65536 + gap);
  if (gapStart >= from && gapEnd <= to) {
    return text.slice(from, gapStart) + text.slice(gapEnd, to);
  }
  return text.slice(from, to);
}

function readName(dict: string, key: string): string | null {
  const match = new RegExp(`/${key}\\s*/([^\\s/<>\\[\\]()]+)`).exec(dict);
  return match ? match[1]! : null;
}

function readString(dict: string, key: string): string | null {
  const match = new RegExp(`/${key}\\s*(\\(|<(?!<))`).exec(dict);
  if (!match) return null;
  const start = match.index + match[0].length;
  const raw = match[1] === '(' ? readLiteral(dict, start) : readHex(dict, start);
  if (raw === null) return null;
  const value = decodeTextString(raw).trim();
  return value.length > 0 ? value.slice(0, 500) : null;
}

/** literal string ของ PDF: วงเล็บซ้อนกันได้ และมี escape \n \( \ddd ฯลฯ — คืนเป็นไบต์ (latin1) */
function readLiteral(dict: string, start: number): string | null {
  let depth = 1;
  let out = '';
  for (let i = start; i < dict.length; i++) {
    const ch = dict[i]!;
    if (ch === '\\') {
      const next = dict[i + 1];
      if (next === undefined) return null;
      const octal = /^[0-7]{1,3}/.exec(dict.slice(i + 1, i + 4));
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
        i += octal[0].length;
        continue;
      }
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      if (next === '\r' || next === '\n') {
        // ขึ้นบรรทัดหลัง \ = ต่อบรรทัด (ไม่ใช่ข้อมูล)
        i += next === '\r' && dict[i + 2] === '\n' ? 2 : 1;
        continue;
      }
      out += escapes[next] ?? next;
      i++;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return out;
    }
    out += ch;
  }
  return null;
}

function readHex(dict: string, start: number): string | null {
  const end = dict.indexOf('>', start);
  if (end === -1) return null;
  let hex = dict.slice(start, end).replace(/\s/g, '');
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex.length % 2 === 1) hex += '0';
  return Buffer.from(hex, 'hex').toString('latin1');
}

/** text string ของ PDF: ขึ้นต้นด้วย BOM FE FF = UTF-16BE, EF BB BF = UTF-8, นอกนั้นถือเป็น latin1 (PDFDocEncoding โดยประมาณ) */
function decodeTextString(raw: string): string {
  const bytes = Buffer.from(raw, 'latin1');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1));
    const swapped = Buffer.from(body);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return raw;
}

/** วันที่แบบ PDF: D:YYYYMMDDHHmmSSOHH'mm (ส่วนท้ายไม่บังคับ) */
export function parsePdfDate(value: string | null): Date | null {
  if (!value) return null;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(value);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', sign, oh = '00', om = '00'] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (sign === '+' || sign === '-') {
    const offset = (Number(oh) * 60 + Number(om)) * 60_000;
    ms += sign === '+' ? -offset : offset;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}
