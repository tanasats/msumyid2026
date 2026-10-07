import { randomBytes } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { config } from '../config/index.js';

// จุดเดียวที่คุยกับ Google — test mock เฉพาะ object นี้ (CLAUDE.md หัวข้อ 15)

export type GoogleAuthRequest = {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
};

/** claim จาก ID token ที่ผ่านการตรวจ signature, aud, iss, exp แล้ว */
export type GoogleIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  /** โดเมนของ Google Workspace (ไม่มีสำหรับ Gmail ทั่วไป) */
  hd: string | null;
  nonce: string | null;
};

function createClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: config.google.redirectUri,
  });
}

export const googleOAuth = {
  /** สร้าง URL ไปหน้า login ของ Google แบบ Authorization Code + PKCE (S256) */
  async createAuthRequest(): Promise<GoogleAuthRequest> {
    const client = createClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const url = client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      access_type: 'online',
      prompt: 'select_account',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, state, nonce, codeVerifier: codeVerifier! };
  },

  /**
   * แลก code เป็น token แล้วตรวจ ID token (signature, aud, iss, exp) ด้วย google-auth-library
   * ส่วน nonce และ email_verified ให้ผู้เรียกตรวจเอง
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const client = createClient();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) {
      throw new Error('Google ไม่ส่ง id_token กลับมา');
    }
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new Error('id_token ไม่มี sub หรือ email');
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      picture: payload.picture ?? null,
      hd: payload.hd ?? null,
      nonce: payload.nonce ?? null,
    };
  },
};
