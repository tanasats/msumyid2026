import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, FileBadge } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser } from '@/lib/auth';

// หน้าแรกหลัง login — ทางเข้าบริการของระบบ (ต้อง login เท่านั้น)
export default async function HomePage() {
  const user = await getCurrentUser();
  // cookie หมดอายุ/ถูกเพิกถอน (proxy ตรวจแค่ว่ามี cookie)
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  return (
    <PageShell title="หน้าหลัก" user={user}>
      <div className="space-y-6">
        <section>
          <h2 className="font-display text-xl font-semibold lg:text-2xl">สวัสดี {user.name}</h2>
          <p className="mt-1 text-muted">ยินดีต้อนรับสู่ MSU Digital ID</p>
        </section>

        <Link
          href="/certificates"
          className="flex min-h-20 items-center gap-4 rounded-xl border border-line bg-surface shadow-card p-4 transition hover:bg-surface-hover sm:p-5"
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
            <FileBadge className="size-6" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">ใบรับรองของฉัน</span>
            <span className="block text-sm text-muted">ขอและดาวน์โหลดใบรับรองสำหรับลงนามและเข้ารหัสอีเมล</span>
          </span>
          <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
        </Link>
      </div>
    </PageShell>
  );
}
