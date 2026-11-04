// ชนิดข้อมูลและป้ายของการแจ้งเตือน (docs/design/notifications.md) — ใช้ได้ทั้ง Server/Client Component
// (ฟังก์ชันเรียก API ฝั่ง server อยู่ที่ lib/notifications.ts)

export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  /** หน้าในระบบที่เกี่ยวข้อง */
  href: string;
  readAt: string | null;
  createdAt: string;
};

export type NotificationPage = { notifications: NotificationItem[]; unreadCount: number; nextCursor: string | null };

export type NotificationCategory = 'decisions' | 'expiry' | 'approver_digest';

export type NotificationPreference = {
  category: NotificationCategory;
  inApp: boolean;
  email: boolean;
  /** หมวดนี้มีเฉพาะอีเมล */
  emailOnly: boolean;
};

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, { title: string; detail: string }> = {
  decisions: { title: 'ผลการพิจารณาคำขอ', detail: 'คำขอใบรับรองและคำขอเพิกถอนได้รับอนุมัติหรือถูกปฏิเสธ' },
  expiry: { title: 'ใบรับรองใกล้หมดอายุ', detail: 'เตือนก่อนหมดอายุ 30 วันและ 7 วัน' },
  approver_digest: { title: 'สรุปงานรอพิจารณา', detail: 'ทุกเช้าวันทำการที่มีงานค้างในคิวของคุณ (ทางอีเมลเท่านั้น)' },
};
