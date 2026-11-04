import { apiFetch } from './api-server';
import type { NotificationPage, NotificationPreference } from './notification';

// เรียก API การแจ้งเตือนจาก Server Component — ข้อความไทยสร้างที่ API (แม่แบบชุดเดียวกับอีเมล)

export async function getMyNotifications(before?: string): Promise<NotificationPage> {
  return apiFetch<NotificationPage>(`/me/notifications${before ? `?before=${encodeURIComponent(before)}` : ''}`);
}

export async function getMyNotificationPreferences(): Promise<NotificationPreference[]> {
  return (await apiFetch<{ preferences: NotificationPreference[] }>('/me/notification-preferences')).preferences;
}
