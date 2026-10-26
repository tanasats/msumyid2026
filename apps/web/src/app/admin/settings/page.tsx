import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CalendarClock, ChevronRight, History, KeyRound, type LucideIcon } from 'lucide-react';
import { SystemSettingsForm } from '@/components/admin/SystemSettingsForm';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { getSystemSettings } from '@/lib/system-settings';
import { describeSettingChanges } from '@/lib/system-settings-format';

export const metadata: Metadata = { title: 'ตั้งค่าระบบ' };

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

type Shortcut = { href: string; icon: LucideIcon; title: string; detail: string };

// หน้ารวมการตั้งค่า: ทางลัดไปหน้าตั้งค่าอื่นที่มีสิทธิ์ + ค่าตั้งของระบบ (super_admin — API ตรวจทุกหน้า เว็บซ่อนเพื่อ UX)
export default async function AdminSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);

  const shortcuts: Shortcut[] = [
    ...(user.capabilities.manageRoles
      ? [{ href: '/admin/roles', icon: KeyRound, title: 'บทบาทและสิทธิ์', detail: 'สร้างบทบาทและกำหนดว่าแต่ละบทบาททำอะไรได้' }]
      : []),
    ...(user.permissions.includes('certificate_policy:manage')
      ? [
          {
            href: '/admin/certificate-policy',
            icon: CalendarClock,
            title: 'นโยบายอายุใบรับรอง',
            detail: 'อายุใบรับรองประจำตัว ช่วงต่ออายุ และเพดานของใบรับรองเสริม',
          },
        ]
      : []),
  ];
  if (!user.capabilities.manageSettings && shortcuts.length === 0) redirect('/forbidden');

  const data = user.capabilities.manageSettings ? await getSystemSettings() : null;

  return (
    <PageShell title="ตั้งค่าระบบ" user={user} width="form">
      <div className="space-y-6">
        {shortcuts.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {shortcuts.map(({ href, icon: Icon, title, detail }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="group flex min-h-16 items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition hover:border-line-input hover:bg-surface-hover"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{title}</span>
                    <span className="mt-0.5 block text-sm text-muted">{detail}</span>
                  </span>
                  <ChevronRight className="mt-2 size-5 shrink-0 text-muted transition group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}

        {data && (
          <>
            <SystemSettingsForm initial={data.settings} />

            <section aria-labelledby="settings-history" className="rounded-xl border border-line bg-surface shadow-card">
              <h2 id="settings-history" className="px-5 pt-5 font-display text-lg font-semibold sm:px-6 sm:pt-6">
                ประวัติการแก้ไข
              </h2>
              {data.logs.length === 0 ? (
                <StatusState icon={History} title="ยังไม่มีการแก้ไข">
                  ระบบใช้ค่าเริ่มต้น: โดเมน msu.ac.th, เข้าระบบได้ 7 วัน, CRL อายุ 7 วัน ออกใหม่ทุก 24 ชั่วโมง
                </StatusState>
              ) : (
                <ol className="mt-3 divide-y divide-line">
                  {data.logs.map((log) => (
                    <li key={log.id} className="px-5 py-4 sm:px-6">
                      <p className="text-sm">
                        <span className="font-medium">{log.actor?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'}</span>
                        <span className="text-muted"> · {dateTimeFormatter.format(new Date(log.createdAt))}</span>
                      </p>
                      <ul className="mt-1 space-y-0.5 text-sm text-muted">
                        {describeSettingChanges(log).map((change) => (
                          <li key={change} className="break-words">
                            {change}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 text-sm break-words">เหตุผล: {log.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </PageShell>
  );
}
