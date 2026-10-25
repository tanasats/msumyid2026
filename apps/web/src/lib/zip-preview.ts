// อ่าน PDF ไฟล์แรกใน ZIP บนเครื่องผู้ใช้ (ใช้ใน Client Component เท่านั้น) เพื่อแสดงตัวอย่างสำหรับวางลายเซ็น
// อ่านแบบ stream แล้วหยุดทันทีที่ได้ไฟล์แรก ไม่โหลด ZIP ทั้งก้อน — การตรวจจริงทำที่ worker ตอนแตก ZIP เสมอ
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { MAX_SIGNING_PDF_BYTES } from './signing';

/** ไฟล์ขยะของ macOS/Windows และ path ที่ worker จะข้าม (ตรงกับ signing-zip.ts ของ API) */
function isCandidate(name: string): boolean {
  const path = name.replace(/\\/g, '/');
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  if (!base.toLowerCase().endsWith('.pdf') || parts.includes('__MACOSX') || base.startsWith('._')) return false;
  return !path.startsWith('/') && !parts.some((p) => p === '' || p === '.' || p === '..');
}

/** PDF ไฟล์แรกที่ลงนามได้ใน ZIP — null = ไม่พบ (หรือไฟล์ใหญ่เกินกำหนด) */
export async function firstPdfInZip(zip: Blob): Promise<File | null> {
  const reader = zip.stream().getReader();
  return new Promise<File | null>((resolve, reject) => {
    let found = false;
    let done = false;
    const finish = (result: File | null) => {
      if (done) return;
      done = true;
      void reader.cancel();
      resolve(result);
    };

    const unzip = new Unzip((entry) => {
      if (found || !isCandidate(entry.name)) return;
      found = true;
      const chunks: Uint8Array[] = [];
      let size = 0;
      entry.ondata = (err, chunk, final) => {
        if (err) return finish(null);
        size += chunk.length;
        if (size > MAX_SIGNING_PDF_BYTES) return finish(null);
        chunks.push(chunk);
        if (final) {
          const name = entry.name.split(/[\\/]/).at(-1) ?? 'document.pdf';
          finish(new File(chunks as BlobPart[], name, { type: 'application/pdf' }));
        }
      };
      entry.start();
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);

    const pump = async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (done) return;
          if (end) {
            unzip.push(new Uint8Array(0), true);
            return finish(null);
          }
          unzip.push(value);
        }
      } catch (err) {
        if (!done) reject(err);
      }
    };
    void pump();
  });
}
