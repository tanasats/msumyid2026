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
  // ชื่อ cookie ต้องเฉพาะโปรเจกต์ เพราะ cookie บน localhost ใช้ร่วมกันทุก port
  SESSION_COOKIE_NAME: z.string().regex(/^[a-z0-9_]+$/),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  // ต้องตรงกับ redirect URI ที่ลงทะเบียนกับ Google ทุกตัวอักษร
  GOOGLE_REDIRECT_URI: z.url(),
  // โดเมนที่ไม่ต้องรออนุมัติ (คั่นด้วย ,) — โดเมนอื่น = บุคลากรภายนอก รออนุมัติ
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .transform((v) =>
      v
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1)),
  // ERP-HR มมส. เรียกด้วย Google access token ของบุคลากรตอน login (CLAUDE.md หัวข้อ 18)
  ERP_HR_STAFFINFO_URL: z.url(),
  // ERP ช้าหรือล่มต้องไม่ทำให้ login ค้าง — เกินเวลานี้ข้ามไป
  ERP_HR_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
  // รอบตรวจปิดบัญชีที่ถึงวันหมดอายุ (การตัดสิทธิ์มีผลทันทีอยู่แล้ว job นี้ปิดบัญชีและเขียน audit log)
  ACCOUNT_EXPIRY_CHECK_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  // บริการเซ็น (apps/signer) ออกใบรับรองและถือ key สำรอง — เรียกผ่านเครือข่ายภายในด้วย token ร่วม
  SIGNER_URL: z.url(),
  SIGNER_TOKEN: z.string().min(32),
  // สร้าง RSA 4096 อาจใช้เวลาหลายวินาที
  SIGNER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  // CRL: อายุแต่ละฉบับ (next_update) — ผู้ตรวจใบรับรองอาจเก็บ CRL ไว้ใช้จนถึงวันนี้ จึงไม่ควรยาวเกินไป
  CRL_VALIDITY_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // ออกฉบับใหม่ทุกกี่ชั่วโมงแม้ไม่มีการเพิกถอน (ต้องน้อยกว่าอายุ CRL มาก เผื่อ signer ล่ม)
  CRL_REISSUE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // รอบตรวจว่าต้องออก CRL ใหม่หรือไม่ (ออกใหม่ทันทีเมื่อเพิกถอนอยู่แล้ว รอบนี้ใช้ลองใหม่เมื่อ signer ล่ม)
  CRL_CHECK_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
  // รูปแบบไฟล์ที่เผยแพร่: pem = แบบเดียวกับที่ openssl ca -gencrl ของระบบเดิมสร้าง, der = ตาม RFC 5280
  CRL_PUBLISH_FORMAT: z.enum(['pem', 'der']).default('pem'),
  // ใช้เฉพาะสคริปต์ seed:super-admin (ไม่บังคับตอนรัน API) — สคริปต์ตรวจเองว่ามีค่า
  INITIAL_SUPER_ADMIN_EMAIL: z.email().optional(),
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
  session: {
    cookieName: env.SESSION_COOKIE_NAME,
    ttlMs: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  },
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  },
  allowedEmailDomains: env.ALLOWED_EMAIL_DOMAINS,
  erpHr: {
    staffInfoUrl: env.ERP_HR_STAFFINFO_URL,
    timeoutMs: env.ERP_HR_TIMEOUT_MS,
  },
  accountExpiryCheckIntervalMs: env.ACCOUNT_EXPIRY_CHECK_INTERVAL_MS,
  signer: {
    url: env.SIGNER_URL,
    token: env.SIGNER_TOKEN,
    timeoutMs: env.SIGNER_TIMEOUT_MS,
  },
  crl: {
    validityMs: env.CRL_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    reissueHours: env.CRL_REISSUE_HOURS,
    checkIntervalMs: env.CRL_CHECK_INTERVAL_MS,
    publishFormat: env.CRL_PUBLISH_FORMAT,
  },
  initialSuperAdminEmail: env.INITIAL_SUPER_ADMIN_EMAIL,
} as const;
