// เรียก API จาก Client Component (browser) — ส่ง cookie ด้วย credentials: 'include' (CLAUDE.md หัวข้อ 14)
// browser ใส่ header Origin ให้เองกับ POST/DELETE ซึ่ง API ใช้ตรวจ CSRF

/** error จาก API พร้อมข้อความภาษาไทยที่แสดงให้ผู้ใช้ได้ */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** แปลงคำตอบที่ไม่สำเร็จเป็น ApiClientError พร้อมข้อความจาก API */
async function toApiError(res: Response): Promise<ApiClientError> {
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  return new ApiClientError(
    res.status,
    data?.error?.code ?? 'UNKNOWN',
    data?.error?.message ?? 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
  );
}

/** อ่านข้อมูลจาก browser (เช่น ค้นหาขณะพิมพ์) — signal ใช้ยกเลิกคำขอเก่าเมื่อพิมพ์ต่อ */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, { credentials: 'include', signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiClientError(0, 'NETWORK_ERROR', 'เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/**
 * อัปโหลดไฟล์ดิบ (body = ไฟล์ทั้งไฟล์) แล้วคืน JSON ที่ API ตอบ
 * ใช้ XMLHttpRequest แทน fetch เพราะต้องแสดงความคืบหน้าของการอัปโหลด (fetch ไม่มี) และยกเลิกได้ด้วย signal
 */
export function apiUpload<T>(
  path: string,
  file: File,
  { contentType, onProgress, signal }: { contentType: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${process.env.NEXT_PUBLIC_API_URL}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      const data = xhr.response as { error?: { code: string; message: string } } | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      reject(
        new ApiClientError(
          xhr.status,
          data?.error?.code ?? 'UNKNOWN',
          data?.error?.message ??
            (xhr.status === 413 ? 'ไฟล์ใหญ่เกินกำหนด' : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'),
        ),
      );
    };
    xhr.onerror = () =>
      reject(new ApiClientError(0, 'NETWORK_ERROR', 'เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'));
    xhr.onabort = () => reject(new DOMException('ยกเลิกแล้ว', 'AbortError'));

    if (signal?.aborted) {
      reject(new DOMException('ยกเลิกแล้ว', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** ส่งคำขอเปลี่ยนข้อมูล — คืน JSON ที่ API ตอบ (204 No Content = undefined) */
export async function apiMutate<T = void>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: object = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError(0, 'NETWORK_ERROR', 'เชื่อมต่อระบบไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
  }
  if (!res.ok) throw await toApiError(res);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/**
 * อัปโหลดไฟล์ตรงเข้า storage ด้วย presigned URL ที่ API ออกให้ (PUT ไม่ผ่าน API — CLAUDE.md หัวข้อ 11)
 * Content-Type ต้องตรงกับที่ API ลงนามไว้ใน URL ไม่ส่ง cookie (storage ตรวจสิทธิ์จากลายเซ็นของ URL)
 */
export function uploadToStorage(
  url: string,
  file: Blob,
  { contentType, onProgress, signal }: { contentType: string; onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      // 403 แบบ HTML = WAF ของ Cloudflare บล็อกก่อนถึงเซิร์ฟเวอร์ (Garage ตอบ 403 เป็น XML เช่น URL หมดอายุ) — docs/deployment.md หัวข้อ 12
      else if (xhr.status === 403 && xhr.getResponseHeader('Content-Type')?.includes('text/html'))
        reject(new ApiClientError(403, 'UPLOAD_BLOCKED', 'ระบบป้องกันของเครือข่ายปฏิเสธการอัปโหลด กรุณาแจ้งผู้ดูแลระบบ'));
      else reject(new ApiClientError(xhr.status, 'UPLOAD_FAILED', 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'));
    };
    xhr.onerror = () =>
      reject(new ApiClientError(0, 'NETWORK_ERROR', 'อัปโหลดไฟล์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'));
    xhr.onabort = () => reject(new DOMException('ยกเลิกแล้ว', 'AbortError'));

    if (signal?.aborted) {
      reject(new DOMException('ยกเลิกแล้ว', 'AbortError'));
      return;
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** ดาวน์โหลดไฟล์ของตัวเองจาก storage: ขอ URL อายุสั้นจาก API แล้วให้ browser เปิด (ชื่อไฟล์มากับ Content-Disposition) */
export async function downloadMyFile(fileId: string): Promise<void> {
  const { url } = await apiGet<{ url: string }>(`/me/files/${fileId}/download`);
  window.location.assign(url);
}
