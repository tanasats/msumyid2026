'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { apiGet } from '@/lib/api-client';

/** ดึงจำนวนที่ยังไม่อ่านใหม่ทุก 60 วินาทีขณะเปิดแท็บอยู่ (docs/design/notifications.md — ไม่ใช้ WebSocket) */
const POLL_INTERVAL_MS = 60_000;

/** กระดิ่งบน header: ไปหน้า /notifications พร้อมจำนวนที่ยังไม่อ่าน — อัปเดตเมื่อเปลี่ยนหน้าและตามรอบ */
export function NotificationBell() {
  const pathname = usePathname();
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      apiGet<{ unreadCount: number }>('/me/notifications/unread-count', controller.signal)
        .then((data) => setUnread(data.unreadCount))
        // ดึงไม่สำเร็จ (เครือข่าย/session หมดอายุ) — คงตัวเลขเดิมไว้ หน้าหลักจัดการเรื่อง login เอง
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [pathname]);

  const active = pathname === '/notifications';
  const label = unread ? `การแจ้งเตือน ยังไม่อ่าน ${unread} รายการ` : 'การแจ้งเตือน';
  return (
    <Link
      href="/notifications"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`relative flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-surface-hover ${
        active ? 'bg-accent-soft text-accent-soft-fg' : 'text-fg'
      }`}
    >
      <Bell className="size-6" aria-hidden />
      {!!unread && (
        <span
          aria-hidden
          className="absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-xs font-semibold tabular-nums leading-none text-on-danger ring-2 ring-surface"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
