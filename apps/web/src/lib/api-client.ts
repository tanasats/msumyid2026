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

/** ส่งคำขอเปลี่ยนข้อมูล — คืน JSON ที่ API ตอบ (204 No Content = undefined) */
export async function apiMutate<T = void>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
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
