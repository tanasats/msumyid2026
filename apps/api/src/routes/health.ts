import { Router } from 'express';
import { checkHealth } from '../services/health-service.js';

export const healthRouter = Router();

// สิทธิ์: public (ใช้โดย load balancer / monitoring)
healthRouter.get('/health', async (_req, res) => {
  const health = await checkHealth();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});
