import 'dotenv/config';
import { z } from 'zod';

// ตรวจ env ตอนเริ่มระบบ ถ้าขาดหรือผิดรูปแบบให้หยุดทำงานทันที (CLAUDE.md หัวข้อ 6)
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive(),
  // production หลัง nginx = 1 (จำนวน hop) ห้ามใช้ true เพราะจะเชื่อ X-Forwarded-For ทุกตัว
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined))
    .pipe(z.number().int().nonnegative().optional()),
  WEB_URL: z.url(),
  CORS_ORIGIN: z.url(),
  DATABASE_URL: z.url(),
  TEST_DATABASE_URL: z.url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // ใช้ console ตรงนี้เพราะ logger ยังไม่ถูกสร้าง (logger อ่าน config)
  console.error('ค่า env ไม่ถูกต้อง:', z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === 'test' && !env.TEST_DATABASE_URL) {
  console.error('ค่า env ไม่ถูกต้อง: ต้องกำหนด TEST_DATABASE_URL เมื่อรัน test');
  process.exit(1);
}

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  trustProxy: env.TRUST_PROXY,
  webUrl: env.WEB_URL,
  corsOrigin: env.CORS_ORIGIN,
  // ตอนรัน test ใช้ app_test เสมอ เพื่อไม่ให้ test แตะ app_dev
  databaseUrl: env.NODE_ENV === 'test' ? (env.TEST_DATABASE_URL as string) : env.DATABASE_URL,
  logLevel: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
} as const;
