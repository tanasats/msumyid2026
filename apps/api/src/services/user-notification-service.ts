import { pool } from '../db/pool.js';
import type { Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import { enqueueEmail } from '../mail/outbox.js';
import {
  EMAIL_ONLY_TEMPLATES,
  EMAIL_TEMPLATES,
  NOTICE_CATEGORIES,
  isOptionalCategory,
  renderInAppNotification,
  type EmailNotice,
  type OptionalCategory,
} from '../mail/templates.js';
import {
  countUnreadNotifications,
  deleteNotificationsCreatedBefore,
  findNotificationPreference,
  insertNotification,
  listNotificationPreferences,
  listNotificationsOfUser,
  markAllNotificationsRead,
  markNotificationRead,
  upsertNotificationPreference,
} from '../repositories/user-notification-repository.js';
import { hasPermission, type AuthUser } from './authorization-service.js';
import { PERMISSIONS } from './permissions.js';

// การแจ้งเตือนผู้ใช้ (docs/design/notifications.md): ในระบบ + อีเมล ตามการตั้งค่าของผู้รับ

/** ระยะเก็บการแจ้งเตือนในระบบ (ประกาศความเป็นส่วนตัว) */
export const NOTIFICATION_RETENTION_DAYS = 90;
const PAGE_SIZE = 20;

/**
 * แจ้งผู้ใช้ — จุดเดียวที่ทุกเหตุการณ์เรียก ใน transaction เดียวกับงาน (งาน rollback = ไม่มีการแจ้งเตือน)
 * หมวดที่ปิดได้อ่านการตั้งค่าของผู้รับ (ไม่มีแถว = เปิดทั้งสองช่องทาง), หมวดบังคับ (บัญชี/ความปลอดภัย) แจ้งทั้งสองช่องทางเสมอ
 */
export async function notify(
  db: Queryable,
  userId: string,
  notice: EmailNotice,
): Promise<{ inApp: boolean; email: boolean }> {
  const category = NOTICE_CATEGORIES[notice.template];
  const preference = isOptionalCategory(category) ? await findNotificationPreference(db, userId, category) : null;
  const inApp = (preference?.inApp ?? true) && !EMAIL_ONLY_TEMPLATES.includes(notice.template);
  const email = preference?.email ?? true;
  if (inApp) await insertNotification(db, { userId, template: notice.template, params: notice.params });
  if (email) await enqueueEmail(db, userId, notice);
  return { inApp, email };
}

export type MyNotification = {
  id: string;
  title: string;
  body: string;
  href: string;
  readAt: Date | null;
  createdAt: Date;
};

export async function listMyNotifications(
  user: AuthUser,
  before: string | null,
): Promise<{ notifications: MyNotification[]; unreadCount: number; nextCursor: string | null }> {
  const rows = await listNotificationsOfUser(pool, { userId: user.id, before, limit: PAGE_SIZE + 1 });
  const page = rows.slice(0, PAGE_SIZE);
  const notifications = page
    // แม่แบบที่ถูกเลิกใช้แล้ว (ยังค้างอยู่ไม่เกิน 90 วัน) ไม่แสดง
    .filter((row) => (EMAIL_TEMPLATES as readonly string[]).includes(row.template))
    .map((row) => ({
      id: row.id,
      // params มาจาก notify ที่ตรวจชนิดด้วย EmailNotice แล้ว
      ...renderInAppNotification({ template: row.template, params: row.params } as EmailNotice),
      readAt: row.readAt,
      createdAt: row.createdAt,
    }));
  return {
    notifications,
    unreadCount: await countUnreadNotifications(pool, user.id),
    nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.id : null,
  };
}

export async function getMyUnreadNotificationCount(user: AuthUser): Promise<number> {
  return countUnreadNotifications(pool, user.id);
}

/** ของคนอื่นตอบ "ไม่พบ" เหมือนไม่มีอยู่ */
export async function markMyNotificationRead(user: AuthUser, id: string): Promise<void> {
  if (!(await markNotificationRead(pool, { userId: user.id, id }))) {
    throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'ไม่พบการแจ้งเตือนนี้');
  }
}

export async function markAllMyNotificationsRead(user: AuthUser): Promise<void> {
  await markAllNotificationsRead(pool, user.id);
}

export type MyNotificationPreference = {
  category: OptionalCategory;
  inApp: boolean;
  email: boolean;
  /** true = หมวดนี้มีเฉพาะอีเมล (ไม่มีช่องในระบบ) */
  emailOnly: boolean;
};

/** หมวดที่ผู้ใช้ตั้งได้ — สรุปงานผู้อนุมัติเฉพาะผู้มีสิทธิ์พิจารณางานในคิวใดคิวหนึ่ง */
function availableCategories(user: AuthUser): OptionalCategory[] {
  const approver = [PERMISSIONS.USER_APPROVE, PERMISSIONS.CERTIFICATE_APPROVE, PERMISSIONS.CERTIFICATE_REVOKE].some((p) =>
    hasPermission(user, p),
  );
  return approver ? ['decisions', 'expiry', 'approver_digest'] : ['decisions', 'expiry'];
}

export async function getMyNotificationPreferences(user: AuthUser): Promise<MyNotificationPreference[]> {
  const saved = new Map((await listNotificationPreferences(pool, user.id)).map((row) => [row.category, row]));
  return availableCategories(user).map((category) => {
    const emailOnly = category === 'approver_digest';
    return {
      category,
      inApp: emailOnly ? false : (saved.get(category)?.inApp ?? true),
      email: saved.get(category)?.email ?? true,
      emailOnly,
    };
  });
}

export async function updateMyNotificationPreference(
  user: AuthUser,
  input: { category: string; inApp: boolean; email: boolean },
): Promise<MyNotificationPreference[]> {
  const category = availableCategories(user).find((c) => c === input.category);
  if (!category) {
    throw new AppError(422, 'CATEGORY_NOT_AVAILABLE', 'การแจ้งเตือนประเภทนี้ปิดไม่ได้ หรือคุณไม่มีการแจ้งเตือนประเภทนี้');
  }
  await upsertNotificationPreference(pool, {
    userId: user.id,
    category,
    // สรุปงานไม่มีในระบบ — เก็บตามค่าเริ่มต้นไว้ ไม่มีผล
    inApp: category === 'approver_digest' ? true : input.inApp,
    email: input.email,
  });
  return getMyNotificationPreferences(user);
}

/** ลบการแจ้งเตือนที่เกินระยะเก็บ */
export async function purgeOldNotifications(now = new Date()): Promise<number> {
  return deleteNotificationsCreatedBefore(pool, new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000));
}
