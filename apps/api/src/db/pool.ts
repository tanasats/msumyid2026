import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../middlewares/logger.js';

// Pool ตัวเดียวทั้งแอป (CLAUDE.md หัวข้อ 10)
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// error จาก client ที่ว่างอยู่ใน pool (เช่น DB restart) ต้อง log ไม่เช่นนั้น process จะล้ม
pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL pool error');
});
