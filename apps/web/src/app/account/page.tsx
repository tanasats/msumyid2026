import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Avatar } from '@/components/Avatar';
import { LogoutButton } from '@/components/LogoutButton';
import { PageShell } from '@/components/PageShell';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

// ข้อมูลบัญชีของผู้ใช้ปัจจุบัน + ออกจากระบบ (ต้อง login เท่านั้น ไม่ต้องมี permission)
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  return (
    <PageShell title="บัญชีของฉัน" user={user} width="form">
      <div className="space-y-6">
        <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <Avatar name={user.name} pictureUrl={user.pictureUrl} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{user.name}</h2>
              <p className="text-sm break-all text-muted">{user.email}</p>
            </div>
          </div>

          <dl className="mt-6 divide-y divide-line border-t border-line text-sm">
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="text-muted sm:w-32 sm:shrink-0">ประเภทบัญชี</dt>
              <dd>{ACCOUNT_TYPE_LABELS[user.accountType]}</dd>
            </div>
            <div className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="text-muted sm:w-32 sm:shrink-0">บทบาท</dt>
              <dd className="flex flex-wrap gap-2">
                {user.roles.map((role) => (
                  <span key={role} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                    {role}
                  </span>
                ))}
              </dd>
            </div>
          </dl>
        </section>

        <LogoutButton />
      </div>
    </PageShell>
  );
}
