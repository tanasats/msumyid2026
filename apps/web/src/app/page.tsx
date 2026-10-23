import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, FileBadge, FileSearch, ShieldCheck, UserRound, Users, type LucideIcon } from 'lucide-react';
import { BentoGrid, cardClasses } from '@/components/Card';
import { IdentityCard } from '@/components/IdentityCard';
import { Landing } from '@/components/landing/Landing';
import { PageShell } from '@/components/PageShell';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';
import { getThemePreference } from '@/lib/theme-server';

type Tile = { href: string; icon: LucideIcon; title: string; detail: string; className?: string };

// หน้าแรก: ยังไม่ login = หน้าแลนดิ้งสาธารณะ (ตรวจลายมือชื่อ + อธิบายความน่าเชื่อถือ) / login แล้ว = ทางเข้าบริการของระบบ
export default async function HomePage() {
  const user = await getCurrentUser();
  // ไม่มี session หรือ cookie หมดอายุ/ถูกเพิกถอน (proxy ตรวจแค่ว่ามี cookie)
  if (!user) return <Landing theme={await getThemePreference()} />;
  if (user.approvalStatus !== 'approved') redirect('/pending');

  // แถวล่าง 3 ช่องเท่ากัน — ช่องที่ 3 เป็นงานผู้ดูแลถ้ามีสิทธิ์ (ซ่อนเพื่อ UX เท่านั้น API ตรวจสิทธิ์เสมอ)
  const tiles: Tile[] = [
    {
      href: '/certificates',
      icon: FileBadge,
      title: 'ใบรับรองของฉัน',
      detail: 'ขอและดาวน์โหลดใบรับรองสำหรับลงนามเอกสารและเข้ารหัสอีเมล',
    },
    {
      href: '/verify',
      icon: FileSearch,
      title: 'ตรวจสอบลายมือชื่อ',
      detail: 'อัปโหลด PDF เพื่อตรวจว่าเอกสารไม่ถูกแก้ไขและใครเป็นผู้ลงนาม',
    },
    {
      href: '/root-ca',
      icon: ShieldCheck,
      title: 'ติดตั้งใบรับรองหลัก',
      detail: 'ให้ Acrobat และ Foxit เชื่อถือลายมือชื่อของมหาวิทยาลัย',
    },
    user.permissions.includes('user:read')
      ? { href: '/admin/users', icon: Users, title: 'ผู้ใช้ระบบ', detail: 'ค้นหา อนุมัติ และจัดการบัญชีผู้ใช้' }
      : { href: '/account', icon: UserRound, title: 'บัญชีของฉัน', detail: 'ข้อมูลบัญชี โหมดสว่าง/มืด และขนาดตัวอักษร' },
  ];

  return (
    <PageShell title="หน้าหลัก" user={user}>
      <BentoGrid>
        <IdentityCard
          name={user.name}
          email={user.email}
          pictureUrl={user.pictureUrl}
          accountTypeLabel={ACCOUNT_TYPE_LABELS[user.accountType]}
          className="md:col-span-2"
        />
        {tiles.map((tile) => (
          <LinkTile key={tile.href} {...tile} />
        ))}
      </BentoGrid>
    </PageShell>
  );
}

/** ช่องลิงก์ในกริด — ทั้งช่องกดได้ ไอคอนบน ข้อความล่าง */
function LinkTile({ href, icon: Icon, title, detail, className = '' }: Tile) {
  return (
    <Link
      href={href}
      className={`${cardClasses} group flex min-h-40 flex-col transition hover:border-line-input hover:bg-surface-hover ${className}`}
    >
      <span className="flex items-start justify-between">
        <span className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
          <Icon className="size-6" aria-hidden />
        </span>
        <ChevronRight className="size-5 text-muted transition group-hover:translate-x-0.5" aria-hidden />
      </span>
      <span className="mt-auto pt-6">
        <span className="block font-semibold">{title}</span>
        <span className="mt-1 block text-sm leading-relaxed text-muted">{detail}</span>
      </span>
    </Link>
  );
}
