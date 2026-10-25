// แสดงตัวอย่าง PDF ในเครื่องผู้ใช้ด้วย pdf.js (ใช้ใน Client Component เท่านั้น) — ไฟล์ไม่ถูกส่งไปไหนจนกว่าจะกดลงนาม
import type { PDFDocumentProxy } from 'pdfjs-dist';

let loader: Promise<typeof import('pdfjs-dist')> | null = null;

/** โหลด pdf.js ครั้งเดียวเมื่อต้องใช้ (โค้ดใหญ่ ไม่ใส่ใน bundle หลักของหน้า) และตั้ง worker แยก thread */
function pdfjs() {
  loader ??= import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return lib;
  });
  return loader;
}

/** เปิด PDF จากไฟล์ที่ผู้ใช้เลือก — ไฟล์เข้ารหัส/เสีย = throw (ผู้เรียกแสดงข้อความ) */
export async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  return lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

/**
 * วาดหน้า (เริ่ม 1) ลง canvas ให้กว้างเท่า cssWidth — คมตามความละเอียดจอ (devicePixelRatio)
 * ใช้ viewport ที่หมุนตาม /Rotate ของหน้าแล้ว (ตรงกับที่ API แปลงพิกัด)
 * คืนสัดส่วนสูง/กว้างของหน้าที่แสดงผล — signal ยกเลิก = หยุดวาด (เปลี่ยนหน้า/ขนาดจอระหว่างวาด) แล้วคืน null
 */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
  signal: AbortSignal,
): Promise<number | null> {
  const page = await doc.getPage(pageNumber);
  if (signal.aborted) return null;
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * (window.devicePixelRatio || 1) });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${(cssWidth * base.height) / base.width}px`;
  const task = page.render({ canvas, viewport });
  signal.addEventListener('abort', () => task.cancel(), { once: true });
  try {
    await task.promise;
    return base.height / base.width;
  } catch (err) {
    if (signal.aborted) return null;
    throw err;
  }
}

/** สัดส่วนสูง/กว้างของแต่ละหน้าตามที่แสดงผล (หมุนแล้ว) — ใช้คำนวณขนาดกรอบลายเซ็นเริ่มต้น */
export async function pageAspect(doc: PDFDocumentProxy, pageNumber: number): Promise<number> {
  const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
  return viewport.height / viewport.width;
}
