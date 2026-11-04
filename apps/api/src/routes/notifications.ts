import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/auth.js';
import { OPTIONAL_CATEGORIES } from '../mail/templates.js';
import {
  getMyNotificationPreferences,
  getMyUnreadNotificationCount,
  listMyNotifications,
  markAllMyNotificationsRead,
  markMyNotificationRead,
  updateMyNotificationPreference,
} from '../services/user-notification-service.js';

export const notificationsRouter = Router();

// สิทธิ์: ต้อง login เท่านั้น (ไม่ต้องมี permission) — เห็นและแก้ได้เฉพาะของตัวเอง (docs/design/notifications.md)

const listSchema = z.object({ before: z.uuid().optional() });
const idSchema = z.object({ id: z.uuid() });
const preferenceSchema = z.object({
  category: z.enum(OPTIONAL_CATEGORIES),
  inApp: z.boolean(),
  email: z.boolean(),
});

notificationsRouter.get('/me/notifications', requireAuth, async (req, res) => {
  const { before } = listSchema.parse(req.query);
  res.set('Cache-Control', 'no-store');
  res.json(await listMyNotifications(req.user!, before ?? null));
});

// กระดิ่งเรียกทุกหน้า + ทุก 60 วินาที — นับจาก partial index อย่างเดียว
notificationsRouter.get('/me/notifications/unread-count', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ unreadCount: await getMyUnreadNotificationCount(req.user!) });
});

notificationsRouter.post('/me/notifications/read-all', requireAuth, async (req, res) => {
  await markAllMyNotificationsRead(req.user!);
  res.status(204).end();
});

notificationsRouter.post('/me/notifications/:id/read', requireAuth, async (req, res) => {
  const { id } = idSchema.parse(req.params);
  await markMyNotificationRead(req.user!, id);
  res.status(204).end();
});

notificationsRouter.get('/me/notification-preferences', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ preferences: await getMyNotificationPreferences(req.user!) });
});

notificationsRouter.put('/me/notification-preferences', requireAuth, async (req, res) => {
  const input = preferenceSchema.parse(req.body);
  res.json({ preferences: await updateMyNotificationPreference(req.user!, input) });
});
