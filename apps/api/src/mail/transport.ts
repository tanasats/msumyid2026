import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/index.js';
import { logger } from '../middlewares/logger.js';
import { buildMime } from './mime.js';

// จุดเดียวที่ส่งอีเมลออกจากระบบ — test mock เฉพาะ object นี้ (docs/design/email.md)
// log = เขียน log แทนการส่ง (dev/test) / gmail = Gmail API ของบัญชีระบบ (scope gmail.send — ส่งได้อย่างเดียว อ่านกล่องจดหมายไม่ได้)

export type OutgoingEmail = {
  to: string;
  toName: string | null;
  subject: string;
  text: string;
};

/** ส่งไม่สำเร็จ — permanent = ลองใหม่ก็ไม่ผ่าน (เช่น ผู้รับผิดรูปแบบ) ไม่ต้องลองซ้ำ */
export class MailError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MailError';
  }
}

const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_TIMEOUT_MS = 15_000;

// client ตัวเดียว — เก็บ access token ไว้ใช้ซ้ำจนใกล้หมดอายุ (ไม่ขอใหม่ทุกฉบับ)
let gmailClient: OAuth2Client | null = null;

function getGmailClient(): OAuth2Client {
  if (!gmailClient) {
    gmailClient = new OAuth2Client({ clientId: config.mail.gmail.clientId, clientSecret: config.mail.gmail.clientSecret });
    gmailClient.setCredentials({ refresh_token: config.mail.gmail.refreshToken });
  }
  return gmailClient;
}

async function sendViaGmail(email: OutgoingEmail): Promise<void> {
  let raw: string;
  try {
    raw = buildMime({
      from: { address: config.mail.fromAddress!, name: config.mail.fromName },
      to: { address: email.to, name: email.toName },
      subject: email.subject,
      text: email.text,
    });
  } catch (err) {
    throw new MailError('สร้างอีเมลไม่สำเร็จ (ผู้รับไม่อยู่ในรูปแบบที่ส่งได้)', true, { cause: err });
  }

  let accessToken: string;
  try {
    const { token } = await getGmailClient().getAccessToken();
    if (!token) throw new Error('ไม่ได้ access token');
    accessToken = token;
  } catch (err) {
    // invalid_grant = refresh token ถูกยกเลิก (เปลี่ยนรหัสผ่านบัญชีผู้ส่ง/ถอนสิทธิ์) ต้องรัน mail:authorize ใหม่ — ลองซ้ำไว้ระหว่างรอแก้
    throw new MailError(`ขอ access token ของ Gmail ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`, false, {
      cause: err,
    });
  }

  let res: Response;
  try {
    res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url') }),
      signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new MailError('เรียก Gmail API ไม่สำเร็จ', false, { cause: err });
  }
  if (!res.ok) {
    // body ของ error มีแค่รหัส/ข้อความของ Google ไม่มีเนื้อหาอีเมล
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    // 400 = อีเมลผิดรูปแบบ/ผู้รับไม่ถูกต้อง ลองซ้ำก็ไม่ผ่าน, 401/403/429/5xx = สิทธิ์/โควตา/ล่มชั่วคราว ลองใหม่
    throw new MailError(`Gmail API ตอบ HTTP ${res.status}: ${detail}`, res.status === 400);
  }
}

export const mailTransport = {
  async send(email: OutgoingEmail): Promise<void> {
    if (config.mail.transport === 'gmail') {
      await sendViaGmail(email);
      return;
    }
    // log: production ไม่เขียนผู้รับ/เนื้อหาลง log (ข้อมูลส่วนบุคคล) — dev เขียนเพื่อดูหน้าตาอีเมล
    if (config.isProduction) {
      logger.info({ subject: email.subject }, 'MAIL_TRANSPORT=log: ไม่ได้ส่งอีเมลจริง');
    } else {
      logger.info({ to: email.to, subject: email.subject, text: email.text }, 'MAIL_TRANSPORT=log: อีเมล (ไม่ได้ส่งจริง)');
    }
  },
};
