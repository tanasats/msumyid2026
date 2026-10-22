import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, FileBadge, ShieldCheck } from 'lucide-react';
import { Landing } from '@/components/landing/Landing';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser } from '@/lib/auth';
import { getThemePreference } from '@/lib/theme-server';

// หน้าแรก: ยังไม่ login = หน้าแลนดิ้งสาธารณะ (ตรวจลายมือชื่อ + อธิบายความน่าเชื่อถือ) / login แล้ว = ทางเข้าบริการของระบบ
export default async function HomePage() {
  const user = await getCurrentUser();
  // ไม่มี session หรือ cookie หมดอายุ/ถูกเพิกถอน (proxy ตรวจแค่ว่ามี cookie)
  if (!user) return <Landing theme={await getThemePreference()} />;
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

        <Link
          href="/root-ca"
          className="flex min-h-20 items-center gap-4 rounded-xl border border-line bg-surface shadow-card p-4 transition hover:bg-surface-hover sm:p-5"
        >
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">ติดตั้งใบรับรองหลัก (Root)</span>
            <span className="block text-sm text-muted">ให้ Acrobat และ Foxit เชื่อถือลายเซ็นของมหาวิทยาลัย</span>
          </span>
          <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
        </Link>
      </div>
    </PageShell>
  );
}
