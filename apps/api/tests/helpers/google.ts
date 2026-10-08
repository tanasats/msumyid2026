import { vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { googleOAuth, type GoogleIdentity } from '../../src/services/google-oauth.js';

// ตัวช่วยจำลอง login ด้วย Google — mock เฉพาะการเรียก Google (แลก code + ตรวจ ID token)

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME!;

/** เริ่ม login จริงผ่าน GET /auth/google แล้วคืน cookie และ state/nonce ที่ระบบสร้าง */
export async function startLogin(app: Express) {
  const res = await request(app).get('/auth/google');
  const location = new URL(res.headers.location!);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return {
    res,
    location,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
    cookie: cookies.map((c) => c.split(';')[0]).join('; '),
  };
}

export function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    sub: `google-${crypto.randomUUID()}`,
    email: 'somchai.s@msu.ac.th',
    emailVerified: true,
    name: 'สมชาย ใจดี',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    hd: 'msu.ac.th',
    nonce: null,
    // ไม่มี access token = ไม่เรียก ERP-HR (test ของ ERP ส่งค่าเองใน erp-hr.test.ts)
    accessToken: null,
    ...overrides,
  };
}

/** login ครบ flow: เริ่ม → Google ตอบ identity ที่กำหนด (ใส่ nonce ให้ตรงอัตโนมัติ) → callback */
export async function loginWith(app: Express, overrides: Partial<GoogleIdentity> = {}) {
  const start = await startLogin(app);
  const exchange = vi
    .spyOn(googleOAuth, 'exchangeCode')
    .mockResolvedValue(identity({ nonce: start.nonce, ...overrides }));
  const res = await request(app)
    .get('/auth/google/callback')
    .query({ code: 'auth-code', state: start.state })
    .set('Cookie', start.cookie);
  return { res, exchange, start };
}

/** cookie session ที่ API ตั้งให้ (ไม่นับ cookie ที่สั่งลบ) */
export function sessionCookieFrom(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
}
