import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BellOff, Settings } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { NotificationList } from '@/components/notifications/NotificationList';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { getMyNotifications } from '@/lib/notifications';

export const metadata: Metadata = { title: 'การแจ้งเตือน' };

// การแจ้งเตือนในระบบของผู้ใช้ปัจจุบัน (ต้อง login เท่านั้น ไม่ต้องมี permission) — เก็บ 90 วัน
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);

  const { before } = await searchParams;
  const page = await getMyNotifications(before);

  const settingsLink = (
    <Link href="/account#notifications" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
      <Settings className="size-5" aria-hidden />
      ตั้งค่าการแจ้งเตือน
    </Link>
  );

  return (
    <PageShell title="การแจ้งเตือน" user={user} width="form">
      {page.notifications.length === 0 ? (
        <StatusState
          icon={BellOff}
          title={before ? 'ไม่มีการแจ้งเตือนเก่ากว่านี้' : 'ยังไม่มีการแจ้งเตือน'}
          action={settingsLink}
        >
          ผลการพิจารณาคำขอ การเตือนใบรับรองใกล้หมดอายุ และการแจ้งเตือนความปลอดภัยจะแสดงที่นี่ (เก็บไว้ 90 วัน)
        </StatusState>
      ) : (
        <>
          <NotificationList items={page.notifications} unreadCount={page.unreadCount} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            {settingsLink}
            {page.nextCursor && (
              <Link
                href={`/notifications?before=${page.nextCursor}`}
                className={buttonClasses({ variant: 'ghost', size: 'sm' })}
              >
                ดูรายการก่อนหน้า
              </Link>
            )}
          </div>
          <p className="mt-4 text-sm text-subtle">การแจ้งเตือนเก็บไว้ 90 วันแล้วลบอัตโนมัติ</p>
        </>
      )}
    </PageShell>
  );
}
