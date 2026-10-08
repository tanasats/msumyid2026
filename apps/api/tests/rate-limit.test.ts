import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createUser, loginAs, resetDatabase } from './helpers/db.js';

// rate limit ของ /auth/* — แยกไฟล์เพราะตัวนับอยู่ในหน่วยความจำของ router (ใช้ร่วมกันทั้งไฟล์)

const app = createApp();
const LIMIT = 100;

beforeAll(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('rate limit', () => {
  it('ไม่จำกัด GET /auth/me (Next.js เรียกทุกหน้าจาก IP เดียวกัน — บั๊กเดิมทำให้ทั้งระบบใช้ไม่ได้)', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    for (let i = 0; i < LIMIT; i += 1) {
      await request(app).get('/auth/me').set('Cookie', cookie);
    }
    const res = await request(app).get('/auth/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('จำกัดขั้นตอนเข้าสู่ระบบ: GET /auth/google เกิน 100 ครั้ง → 429', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      await request(app).get('/auth/google');
    }
    const res = await request(app).get('/auth/google');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');

    // callback ใช้โควตาเดียวกัน
    expect((await request(app).get('/auth/google/callback')).status).toBe(429);
  });
});
