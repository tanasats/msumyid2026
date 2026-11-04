'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CheckCheck, ChevronRight } from 'lucide-react';
import { Button } from '@/components/Button';
import { apiMutate } from '@/lib/api-client';
import type { NotificationItem } from '@/lib/notification';

const timeFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

/**
 * รายการแจ้งเตือน: ยังไม่อ่าน = จุดสีหน้ารายการ + หัวข้อตัวหนา (ไม่สื่อด้วยสีอย่างเดียว — มีข้อความ sr-only)
 * กดรายการ = ทำเครื่องหมายว่าอ่านแล้ว แล้วไปหน้าที่เกี่ยวข้อง
 */
export function NotificationList({ items, unreadCount }: { items: NotificationItem[]; unreadCount: number }) {
  const router = useRouter();
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [allRead, setAllRead] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUnread = (item: NotificationItem) => !allRead && !item.readAt && !readIds.has(item.id);
  const remaining = allRead ? 0 : Math.max(0, unreadCount - items.filter((i) => !i.readAt && readIds.has(i.id)).length);

  async function open(item: NotificationItem) {
    if (isUnread(item)) {
      setReadIds((prev) => new Set(prev).add(item.id));
      // ทำเครื่องหมายไม่สำเร็จไม่ขวางการไปหน้าที่เกี่ยวข้อง (ยังแสดงว่ายังไม่อ่านในครั้งหน้า)
      await apiMutate(`/me/notifications/${item.id}/read`, 'POST').catch(() => undefined);
    }
    router.push(item.href);
  }

  async function markAll() {
    setMarkingAll(true);
    setError(null);
    try {
      await apiMutate('/me/notifications/read-all', 'POST');
      setAllRead(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted" aria-live="polite">
          {remaining > 0 ? `ยังไม่อ่าน ${remaining} รายการ` : 'อ่านครบแล้ว'}
        </p>
        {remaining > 0 && (
          <Button variant="ghost" size="sm" onClick={markAll} loading={markingAll}>
            <CheckCheck className="size-5" aria-hidden />
            อ่านทั้งหมด
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-fg">
          {error}
        </p>
      )}

      <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((item) => {
          const unread = isUnread(item);
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void open(item)}
                className={`flex w-full items-start gap-3 px-4 py-4 text-left hover:bg-surface-hover sm:px-5 ${
                  unread ? 'bg-accent-soft/40' : ''
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-2 size-2.5 shrink-0 rounded-full ${unread ? 'bg-primary' : 'bg-transparent'}`}
                />
                <span className="min-w-0 flex-1">
                  {unread && <span className="sr-only">ยังไม่อ่าน: </span>}
                  <span className={`block ${unread ? 'font-semibold' : 'font-medium'}`}>{item.title}</span>
                  <span className="mt-0.5 block break-words text-sm text-muted">{item.body}</span>
                  <time dateTime={item.createdAt} className="mt-1 block text-xs text-subtle">
                    {timeFormatter.format(new Date(item.createdAt))}
                  </time>
                </span>
                <ChevronRight className="mt-1 size-5 shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
