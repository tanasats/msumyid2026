import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  // ห้าม log ข้อมูลอ่อนไหว (CLAUDE.md หัวข้อ 13) — token ของ API อยู่ใน header Authorization
  redact: {
    paths: ['req.headers.authorization'],
    censor: '[REDACTED]',
  },
});

// ไม่ log body (มีรหัสผ่าน .p12 ชื่อ และอีเมล)
export const requestLogger = pinoHttp({ logger });
