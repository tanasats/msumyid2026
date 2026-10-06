import type { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * รันงานหลายคำสั่งใน transaction เดียว — สำเร็จทั้งหมดหรือย้อนกลับทั้งหมด
 * repository ที่อยู่ใน transaction ต้องรับ client ตัวนี้ไปใช้ (ไม่ใช้ pool ตรง ๆ)
 */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
