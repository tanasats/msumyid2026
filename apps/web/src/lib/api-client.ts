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

export async function apiMutate(path: string, method: 'POST' | 'PATCH' | 'DELETE', body: object = {}): Promise<void> {
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
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiClientError(
      res.status,
      data?.error?.code ?? 'UNKNOWN',
      data?.error?.message ?? 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
    );
  }
}
