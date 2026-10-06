import { cookies } from 'next/headers';
import { serverConfig } from './config';

export type ApiErrorBody = { error: { code: string; message: string } };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * เรียก API จาก Server Component — ส่งต่อ cookie ของผู้ใช้เอง (CLAUDE.md หัวข้อ 14)
 * ไม่เช่นนั้น API จะมองว่ายังไม่ login
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = (await cookies()).toString();

  const res = await fetch(`${serverConfig.apiUrl}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      res.status,
      body?.error.code ?? 'UNKNOWN',
      body?.error.message ?? 'เรียกข้อมูลจากระบบไม่สำเร็จ',
    );
  }

  return (await res.json()) as T;
}
