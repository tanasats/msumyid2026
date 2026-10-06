import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  // ห้าม log ข้อมูลอ่อนไหว (CLAUDE.md หัวข้อ 13)
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    censor: '[REDACTED]',
  },
});

export const requestLogger = pinoHttp({
  logger,
  // ไม่ log query string เพราะอาจมี code/state ของ OAuth
  serializers: {
    req: (req: { id: unknown; method: string; url: string; headers: Record<string, unknown> }) => ({
      id: req.id,
      method: req.method,
      path: req.url.split('?')[0],
      headers: req.headers,
    }),
  },
});
