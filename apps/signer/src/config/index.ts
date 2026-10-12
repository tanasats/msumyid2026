import 'dotenv/config';
import { z } from 'zod';

// ตรวจ env ตอนเริ่มระบบ ถ้าขาดหรือผิดรูปแบบให้หยุดทำงานทันที (CLAUDE.md หัวข้อ 6)
// บริการนี้ถือ key ของ Intermediate CA และ KEK ของ key สำรอง — ห้ามเปิดสู่ภายนอก (docs/design/certificates.md)
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SIGNER_PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // token ร่วมกับ API (header Authorization: Bearer ...) — ยาวพอที่จะเดาไม่ได้
  SIGNER_TOKEN: z.string().min(32),
  // ใช้ OpenSSL CLI ชุดเดียวกับที่ผู้ดูแลใช้ออกใบรับรองอยู่เดิม — ระบุ path ได้ถ้าไม่อยู่ใน PATH
  OPENSSL_BIN: z.string().min(1).default('openssl'),
  // ใบรับรองและ key ของ Intermediate CA (key เข้ารหัสด้วย passphrase)
  CA_CERT_PATH: z.string().min(1),
  CA_KEY_PATH: z.string().min(1),
  CA_KEY_PASSPHRASE: z.string().min(1),
  // ใบรับรอง CA ที่อยู่เหนือ Intermediate (production = root ของ Thai University Consortium) ใส่ลง .p12 ให้ต่อสายถึง root ได้
  // ไม่ใส่หรือว่าง = .p12 มีแค่ Intermediate
  CA_CHAIN_PATH: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  // KEK ของ key สำรอง: AES-256 (32 ไบต์) เข้ารหัสแบบ base64 — สร้างด้วย openssl rand -base64 32
  ESCROW_KEK: z
    .string()
    .transform((v) => Buffer.from(v, 'base64'))
    .refine((key) => key.length === 32, 'ESCROW_KEK ต้องเป็น base64 ของข้อมูล 32 ไบต์'),
  // ชื่อของ KEK ตัวปัจจุบัน (เก็บคู่กับ key สำรองทุกก้อน เพื่อรองรับการเปลี่ยน KEK ภายหลัง)
  ESCROW_KEK_ID: z.string().regex(/^[a-z0-9-]{1,32}$/),
  // URL ของ CRL ที่ฝังในใบรับรองทุกใบ (ใบเดิมใช้ค่านี้อยู่แล้ว เปลี่ยนไม่ได้)
  CRL_DISTRIBUTION_URL: z.url(),
  // อายุใบรับรอง (ระบบเดิมใช้ default_days = 365)
  CERT_VALIDITY_DAYS: z.coerce.number().int().min(1).max(825).default(365),
  // ขนาด RSA key ของผู้ใช้ (ระบบเดิมใช้ 4096) — test ใช้ 2048 เพื่อให้เร็ว
  USER_KEY_BITS: z.coerce.number().int().min(2048).max(8192).default(4096),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // ใช้ console ตรงนี้เพราะ logger ยังไม่ถูกสร้าง (logger อ่าน config)
  console.error('ค่า env ไม่ถูกต้อง:', z.prettifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.SIGNER_PORT,
  logLevel: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  token: env.SIGNER_TOKEN,
  opensslBin: env.OPENSSL_BIN,
  ca: {
    certPath: env.CA_CERT_PATH,
    keyPath: env.CA_KEY_PATH,
    keyPassphrase: env.CA_KEY_PASSPHRASE,
    chainPath: env.CA_CHAIN_PATH,
  },
  escrow: {
    kek: env.ESCROW_KEK,
    kekId: env.ESCROW_KEK_ID,
  },
  crlDistributionUrl: env.CRL_DISTRIBUTION_URL,
  certValidityDays: env.CERT_VALIDITY_DAYS,
  userKeyBits: env.USER_KEY_BITS,
} as const;
