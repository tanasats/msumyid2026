import { PassThrough, type Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { storage } from '../storage/index.js';

// แตก ZIP ของการลงนามหลายไฟล์อย่างปลอดภัย (docs/design/document-signing.md ระยะ D3)
// อ่านจาก storage ทีละช่วง (HTTP Range) ไม่โหลดทั้งไฟล์ — ตรวจทุกรายการจาก central directory ก่อนแตกไฟล์ใด ๆ

const MB = 1024 * 1024;

/** ข้อกำหนดที่ตกลงไว้ (ยืนยัน 2026-10-25) — maxEntries กัน central directory ขนาดมหึมา (รวมโฟลเดอร์/ไฟล์ที่ข้าม) */
export const ZIP_LIMITS = { maxPdfs: 100, maxEntries: 1000, maxPdfBytes: 20 * MB, maxTotalBytes: 500 * MB, maxRatio: 100 } as const;

/** เหตุที่ข้ามรายการ (แสดงให้ผู้ใช้เห็น) — ไม่ทำให้ทั้งชุดล้มเหลว */
export type SkipReason =
  | 'NOT_PDF'
  | 'NESTED_ARCHIVE'
  | 'UNSAFE_PATH'
  | 'ENCRYPTED_ENTRY'
  | 'UNSUPPORTED_COMPRESSION'
  | 'FILE_TOO_LARGE'
  | 'NAME_TOO_LONG'
  | 'DUPLICATE_NAME';

/** ZIP ที่เข้าข่ายอันตรายหรือใช้ไม่ได้ — ปฏิเสธทั้งชุด */
export type ZipRejectCode = 'ZIP_INVALID' | 'ZIP_TOO_MANY_FILES' | 'ZIP_TOO_LARGE' | 'ZIP_BOMB' | 'ZIP_NO_PDF';

export class ZipRejectedError extends Error {
  constructor(
    public readonly code: ZipRejectCode,
    options?: { cause?: unknown },
  ) {
    super(`ZIP ถูกปฏิเสธ: ${code}`, options);
    this.name = 'ZipRejectedError';
  }
}

export type SkippedEntry = { name: string; reason: SkipReason };
export type PdfEntry = { name: string; entry: Entry };
export type ZipPlan = { pdfs: PdfEntry[]; skipped: SkippedEntry[] };

/** ให้ yauzl อ่าน ZIP จาก storage ทีละช่วง — คืน stream ทันที แล้วต่อท่อเมื่อ storage ตอบ */
class StorageRangeReader extends yauzl.RandomAccessReader {
  constructor(private readonly key: string) {
    super();
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    storage.getRangeStream(this.key, start, end).then(
      (stream) => {
        stream.on('error', (err) => out.destroy(err));
        stream.pipe(out);
      },
      (err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))),
    );
    return out;
  }
}

/** เปิด ZIP ใน storage — ไฟล์ไม่ใช่ ZIP/เสีย = ZIP_INVALID (ส่วน storage ล่มส่ง StorageError ต่อให้ผู้เรียกลองใหม่) */
export async function openStoredZip(objectKey: string, size: number): Promise<ZipFile> {
  try {
    return await yauzl.fromRandomAccessReaderPromise(new StorageRangeReader(objectKey), size, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: false,
      validateEntrySizes: true,
    });
  } catch (err) {
    if (isStorageFailure(err)) throw err;
    throw new ZipRejectedError('ZIP_INVALID', { cause: err });
  }
}

/** error ที่มาจาก storage (ให้ลองใหม่) ไม่ใช่จากรูปแบบ ZIP */
export function isStorageFailure(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e.name === 'StorageError') return true;
  }
  return false;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const thai = new TextDecoder('windows-874');

/**
 * ชื่อรายการใน ZIP: มี flag UTF-8 (bit 11) หรือ extra field Unicode Path (0x7075) = ใช้ตามมาตรฐาน
 * ไม่มี = ZIP จาก Windows ภาษาไทยมักเก็บเป็น TIS-620/CP874 — ลองถอดเป็น UTF-8 ก่อน (macOS บางรุ่นไม่ตั้ง flag) ไม่ได้จึงใช้ CP874
 */
export function decodeEntryName(entry: Entry): string {
  if (entry.generalPurposeBitFlag & 0x800 || entry.extraFields.some((f) => f.id === 0x7075)) {
    return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
  }
  try {
    return utf8.decode(entry.fileNameRaw);
  } catch {
    return thai.decode(entry.fileNameRaw);
  }
}

/** ไฟล์ขยะของระบบปฏิบัติการ — ข้ามเงียบ ๆ ไม่แสดงในรายการ */
function isOsJunk(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1)!;
  return parts.includes('__MACOSX') || base.startsWith('._') || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(base);
}

/** path ปลอดภัย: ไม่ใช่ absolute/ไดรฟ์, ไม่มี .. หรือส่วนว่าง, ไม่มีอักขระควบคุม — คืน path ที่ใช้ / หรือ null */
export function safeEntryPath(name: string): string | null {
  const path = name.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex -- ตรวจอักขระควบคุมในชื่อไฟล์โดยเจตนา
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return null;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return path;
}

/**
 * จำแนกทุกรายการจาก central directory (ยังไม่แตกไฟล์): PDF ที่จะลงนาม / รายการที่ข้ามพร้อมเหตุผล
 * ปฏิเสธทั้ง ZIP เมื่อ: รายการเกิน, PDF เกิน 100 ไฟล์, ขนาดรวมหลังแตกเกิน 500 MB, อัตราบีบอัดเกิน 100 เท่า (ZIP bomb), ไม่มี PDF เลย
 * ขนาดที่ประกาศไว้ตรวจซ้ำตอนแตกจริง (validateEntrySizes) — แจ้งเกินจริงไม่ได้
 */
export async function planZip(zip: ZipFile): Promise<ZipPlan> {
  const pdfs: PdfEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  let entries = 0;
  let total = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      if (++entries > ZIP_LIMITS.maxEntries) throw new ZipRejectedError('ZIP_TOO_MANY_FILES');
      const raw = decodeEntryName(entry);
      const name = raw.replace(/\\/g, '/');
      if (name.endsWith('/') || isOsJunk(name)) continue;
      const skip = (reason: SkipReason) => skipped.push({ name: name.slice(0, 255), reason });

      const path = safeEntryPath(raw);
      if (!path) {
        skip('UNSAFE_PATH');
        continue;
      }
      const lower = path.toLowerCase();
      if (/\.(zip|rar|7z|tar|gz|tgz)$/.test(lower)) skip('NESTED_ARCHIVE');
      else if (!lower.endsWith('.pdf')) skip('NOT_PDF');
      else if (entry.isEncrypted()) skip('ENCRYPTED_ENTRY');
      else if (!entry.canDecodeFileData()) skip('UNSUPPORTED_COMPRESSION');
      else if (path.length > 255) skip('NAME_TOO_LONG');
      else if (seen.has(lower)) skip('DUPLICATE_NAME');
      else if (entry.uncompressedSize > ZIP_LIMITS.maxPdfBytes) skip('FILE_TOO_LARGE');
      else {
        // บีบอัดได้เกิน 100 เท่า (หรือขนาดบีบอัด 0 แต่แตกแล้วมีข้อมูล) = ZIP bomb — PDF จริงบีบอัดได้น้อยมาก
        if (entry.uncompressedSize > 0 && entry.uncompressedSize > entry.compressedSize * ZIP_LIMITS.maxRatio) {
          throw new ZipRejectedError('ZIP_BOMB');
        }
        total += entry.uncompressedSize;
        if (total > ZIP_LIMITS.maxTotalBytes) throw new ZipRejectedError('ZIP_TOO_LARGE');
        if (pdfs.length + 1 > ZIP_LIMITS.maxPdfs) throw new ZipRejectedError('ZIP_TOO_MANY_FILES');
        seen.add(lower);
        pdfs.push({ name: path, entry });
      }
    }
  } catch (err) {
    if (err instanceof ZipRejectedError || isStorageFailure(err)) throw err;
    throw new ZipRejectedError('ZIP_INVALID', { cause: err });
  }
  return { pdfs, skipped };
}

/** แตกรายการเป็น Buffer — ขนาดจริงต้องตรงกับที่ประกาศ (yauzl ตรวจ) และไม่เกินขนาดต่อไฟล์ */
export async function readZipEntry(zip: ZipFile, entry: Entry): Promise<Buffer> {
  try {
    const stream = await zip.openReadStreamPromise(entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > ZIP_LIMITS.maxPdfBytes) {
        stream.destroy();
        throw new ZipRejectedError('ZIP_BOMB');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err instanceof ZipRejectedError || isStorageFailure(err)) throw err;
    throw new ZipRejectedError('ZIP_INVALID', { cause: err });
  }
}
