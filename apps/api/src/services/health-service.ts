import { pool } from '../db/pool.js';
import { pingDatabase } from '../repositories/health-repository.js';
import { logger } from '../middlewares/logger.js';

export type HealthStatus = {
  status: 'ok' | 'error';
  database: 'ok' | 'error';
};

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const ok = await pingDatabase(pool);
    return { status: ok ? 'ok' : 'error', database: ok ? 'ok' : 'error' };
  } catch (err) {
    // ไม่โยนต่อ เพราะ health check ต้องตอบสถานะเสมอ แต่ต้อง log ไว้ (ห้ามกลืน error เงียบ ๆ)
    logger.error({ err }, 'Database health check failed');
    return { status: 'error', database: 'error' };
  }
}
