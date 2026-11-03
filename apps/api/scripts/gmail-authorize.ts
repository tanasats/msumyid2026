import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

// ขอ refresh token ของบัญชีผู้ส่งอีเมล (scope gmail.send) — รันครั้งเดียว หรือเมื่อ token ถูกยกเลิก (invalid_grant)
// ใช้: pnpm --filter api mail:authorize (บนเครื่องที่เปิด browser ได้ — ไม่ต้องรันบน VM)
// ต้องมี GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (OAuth client แบบ Desktop app) และ MAIL_FROM_ADDRESS ใน env
// ไม่อ่าน src/config เพราะไม่ต้องใช้ค่าอื่นของ API — ขั้นตอนทั้งหมดดู docs/design/email.md

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

async function main(): Promise<number> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const sender = process.env.MAIL_FROM_ADDRESS?.toLowerCase();
  if (!clientId || !clientSecret || !sender) {
    console.error('ต้องกำหนด GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET และ MAIL_FROM_ADDRESS ใน env (หรือ apps/api/.env)');
    return 1;
  }

  // loopback redirect (OAuth client แบบ Desktop app รับ http://127.0.0.1:<port> ทุก port)
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(32).toString('base64url');

  const url = client.generateAuthUrl({
    // openid email = ตรวจว่า login ด้วยบัญชีผู้ส่งจริง / offline + consent = ได้ refresh token ทุกครั้ง
    scope: ['openid', 'email', GMAIL_SEND_SCOPE],
    access_type: 'offline',
    prompt: 'consent',
    login_hint: sender,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  console.log(`เปิด URL นี้ใน browser แล้วเข้าสู่ระบบด้วย ${sender}:\n\n${url}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const params = new URL(req.url ?? '/', redirectUri).searchParams;
      if (!params.get('code') && !params.get('error')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('กลับไปดูผลที่หน้าต่าง terminal ได้เลย ปิดหน้านี้ได้');
      if (params.get('state') !== state) reject(new Error('state ไม่ตรงกัน'));
      else if (params.get('error')) reject(new Error(`Google ตอบ ${params.get('error')}`));
      else resolve(params.get('code')!);
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.id_token) throw new Error('ไม่ได้ ID token จาก Google');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const email = ticket.getPayload()?.email?.toLowerCase();
  if (email !== sender) {
    console.error(`เข้าสู่ระบบด้วย ${email ?? '(ไม่ทราบอีเมล)'} ไม่ใช่ ${sender} — ไม่ใช้ token นี้ ให้รันใหม่แล้วเลือกบัญชีผู้ส่ง`);
    return 1;
  }
  if (!tokens.scope?.split(' ').includes(GMAIL_SEND_SCOPE)) {
    console.error('ไม่ได้สิทธิ์ส่งอีเมล (gmail.send) — ให้รันใหม่และติ๊กอนุญาตการส่งอีเมล');
    return 1;
  }
  if (!tokens.refresh_token) {
    console.error('Google ไม่ส่ง refresh token กลับมา — ถอนสิทธิ์แอปที่ https://myaccount.google.com/permissions แล้วรันใหม่');
    return 1;
  }

  // ค่าลับ: แสดงบนหน้าจอนี้ครั้งเดียว ไม่เขียนลงไฟล์ — คัดลอกไปใส่ secret ของ production แล้วล้างหน้าจอ
  console.log('สำเร็จ ใส่ค่านี้เป็น GMAIL_REFRESH_TOKEN (production: env/api.env):\n');
  console.log(tokens.refresh_token);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('ไม่สำเร็จ:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
