import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';

const app = createApp();

afterAll(async () => {
  await pool.end();
});

describe('GET /health', () => {
  it('ตอบ 200 เมื่อเชื่อมต่อฐานข้อมูลได้', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('ตอบ 503 เมื่อเชื่อมต่อฐานข้อมูลไม่ได้', async () => {
    const spy = vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection refused') as never);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', database: 'error' });
    spy.mockRestore();
  });

  it('ส่ง header ความปลอดภัยจาก helmet และ CORS ตาม CORS_ORIGIN', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:3010');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3010');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('ไม่อนุญาต origin อื่น', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('http://evil.example');
  });
});

describe('error handler', () => {
  it('เส้นทางที่ไม่มีตอบ 404 รูปแบบ error มาตรฐาน', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'ไม่พบเส้นทางที่ร้องขอ' } });
  });

  it('JSON ผิดรูปแบบตอบ 400 โดยไม่เปิดเผย stack trace', async () => {
    const res = await request(app)
      .post('/health')
      .set('Origin', 'http://localhost:3010')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: 'รูปแบบ JSON ไม่ถูกต้อง' } });
    expect(JSON.stringify(res.body)).not.toMatch(/at .+\(.+\)/);
  });
});
