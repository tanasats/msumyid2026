import { z } from 'zod';
import { config } from '../config/index.js';

// จุดเดียวที่คุยกับบริการเซ็น (apps/signer) — test ของ API mock เฉพาะ object นี้
// signer ถือ key ของ CA และ KEK: API ส่งเฉพาะ subject ที่กำหนดจากฐานข้อมูล และได้ key สำรองกลับมาแบบเข้ารหัสแล้วเท่านั้น

export type IssueCertificateInput = {
  commonName: string;
  email: string;
  p12Password: string;
  legacyP12: boolean;
};

export type IssuedCertificate = {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
  p12: Buffer;
  escrow: { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer };
};

const base64 = z.base64().transform((v) => Buffer.from(v, 'base64'));

const issueResponseSchema = z.object({
  certificatePem: z.string().startsWith('-----BEGIN CERTIFICATE-----'),
  serialNumber: z.string().regex(/^(0|[1-9a-f][0-9a-f]*)$/),
  fingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
  notBefore: z.iso.datetime().transform((v) => new Date(v)),
  notAfter: z.iso.datetime().transform((v) => new Date(v)),
  p12: base64,
  escrow: z.object({
    kekId: z.string().min(1),
    encryptedKey: base64,
    wrappedDataKey: base64,
  }),
});

/** signer ตอบไม่สำเร็จ — ผู้เรียกแปลงเป็น error ที่แสดงผู้ใช้ได้ (ไม่ส่งรายละเอียดภายในออกไป) */
export class SignerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SignerError';
  }
}

const signerErrorSchema = z.object({ error: z.object({ code: z.string() }) });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function post(path: string, body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${config.signer.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.signer.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.signer.timeoutMs),
    });
  } catch (err) {
    throw new SignerError('เรียกบริการเซ็นไม่สำเร็จ', { cause: err });
  }
  if (!res.ok) {
    // body ของ error มีแค่ code/message — ไม่มีข้อมูลอ่อนไหว จึงใส่ใน log ได้
    const detail = await res.text().catch(() => '');
    if (res.status >= 400 && res.status < 500) {
      const code = signerErrorSchema.safeParse(parseJson(detail));
      if (code.success) throw new SignerRejectedError(res.status, code.data.error.code);
    }
    throw new SignerError(`บริการเซ็นตอบ HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export type CrlRevokedEntry = {
  serialNumber: string;
  revokedAt: Date;
  reason: string;
  notAfter: Date;
};

const crlResponseSchema = z.object({ crlDer: base64 });
const p12ResponseSchema = z.object({ p12: base64 });
const legacyKeyResponseSchema = z.object({
  serialNumber: z.string().regex(/^(0|[1-9a-f][0-9a-f]*)$/),
  escrow: z.object({ kekId: z.string().min(1), encryptedKey: base64, wrappedDataKey: base64 }),
});

/** signer ปฏิเสธคำขอ (HTTP 4xx) พร้อมรหัส error ของ signer — เช่น key ไม่คู่กับใบรับรอง */
export class SignerRejectedError extends SignerError {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`บริการเซ็นปฏิเสธคำขอ: ${code}`);
    this.name = 'SignerRejectedError';
  }
}

export const signer = {
  /** ออกใบรับรองใหม่ (สร้าง key → CA เซ็น → .p12 + key สำรองที่เข้ารหัสแล้ว) */
  async issueCertificate(input: IssueCertificateInput): Promise<IssuedCertificate> {
    const parsed = issueResponseSchema.safeParse(await post('/certificates', input));
    if (!parsed.success) {
      throw new SignerError('บริการเซ็นตอบข้อมูลผิดรูปแบบ', { cause: parsed.error });
    }
    return parsed.data;
  },

  /** กู้ key จากที่สำรองไว้แล้วสร้าง .p12 ใหม่ด้วยรหัสผ่านใหม่ (ใบรับรองเดิม) */
  async rebuildP12(input: {
    serialNumber: string;
    certificatePem: string;
    escrow: { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer };
    p12Password: string;
    legacyP12: boolean;
  }): Promise<Buffer> {
    const body = {
      ...input,
      escrow: {
        kekId: input.escrow.kekId,
        encryptedKey: input.escrow.encryptedKey.toString('base64'),
        wrappedDataKey: input.escrow.wrappedDataKey.toString('base64'),
      },
    };
    const parsed = p12ResponseSchema.safeParse(await post('/certificates/p12', body));
    if (!parsed.success) {
      throw new SignerError('บริการเซ็นตอบข้อมูลผิดรูปแบบ', { cause: parsed.error });
    }
    return parsed.data.p12;
  },

  /**
   * นำ key เดิม (เข้ารหัสด้วยรหัสผ่านจากระบบสคริปต์) มาเก็บเป็น key สำรองของใบที่คู่กัน
   * key ไม่ถูกถอดที่ API — signer ถอด จับคู่ด้วย public key แล้วคืนเฉพาะ key สำรองที่เข้ารหัสด้วย KEK
   */
  async escrowLegacyKey(input: {
    privateKeyPem: string;
    passphrases: string[];
    certificates: { serialNumber: string; certificatePem: string }[];
  }): Promise<{ serialNumber: string; escrow: { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer } }> {
    const parsed = legacyKeyResponseSchema.safeParse(await post('/certificates/legacy-key', input));
    if (!parsed.success) {
      throw new SignerError('บริการเซ็นตอบข้อมูลผิดรูปแบบ', { cause: parsed.error });
    }
    return parsed.data;
  },

  /** ออกและเซ็น CRL จากรายการใบที่เพิกถอนทั้งหมด — คืนแบบ DER */
  async generateCrl(input: {
    crlNumber: bigint;
    thisUpdate: Date;
    nextUpdate: Date;
    revoked: CrlRevokedEntry[];
  }): Promise<Buffer> {
    const body = {
      crlNumber: input.crlNumber.toString(),
      thisUpdate: input.thisUpdate.toISOString(),
      nextUpdate: input.nextUpdate.toISOString(),
      revoked: input.revoked.map((r) => ({ ...r, revokedAt: r.revokedAt.toISOString(), notAfter: r.notAfter.toISOString() })),
    };
    const parsed = crlResponseSchema.safeParse(await post('/crls', body));
    if (!parsed.success) {
      throw new SignerError('บริการเซ็นตอบข้อมูลผิดรูปแบบ', { cause: parsed.error });
    }
    return parsed.data.crlDer;
  },
};
