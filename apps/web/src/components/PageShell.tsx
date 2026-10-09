import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import type { CurrentUser } from '@/lib/auth';
import { Avatar } from './Avatar';
import { NavLinks } from './NavLinks';

type PageShellProps = {
  children: React.ReactNode;
  /** ชื่อหน้า แสดงใน header เป็น <h1> ของหน้า — ไม่ระบุ = แสดงชื่อระบบ (หน้าต้องมี h1 ของตัวเอง) */
  title?: string;
  /** หน้าย่อย/ฟอร์ม: แสดงปุ่มย้อนกลับและซ่อน bottom nav บนมือถือ (ลดสิ่งรบกวนระหว่างทำงาน) */
  backHref?: string;
  /** ผู้ใช้ที่ได้รับอนุมัติแล้ว → แสดงเมนูนำทาง ไม่ส่ง = หน้าสาธารณะ/รออนุมัติ (ไม่มีเมนู) */
  user?: CurrentUser;
  /** ความกว้างสูงสุดของเนื้อหา: form = ฟอร์ม, wide = รายการ/ตาราง */
  width?: 'form' | 'wide';
  /** ปุ่มเพิ่มเติมท้าย header (เช่น ตัวเลือกโหมดการแสดงผลในหน้าที่ยังไม่มีเมนู) */
  headerAction?: React.ReactNode;
};

/** ชื่อระบบ: ฟอนต์ display (serif) ภาษาอังกฤษเว้นช่องไฟกว้างเล็กน้อย ให้ความรู้สึกเรียบหรู */
function BrandName({ className = '' }: { className?: string }) {
  return (
    <span className={`leading-tight ${className}`}>
      <span className="block font-display font-semibold tracking-wide">MSU Digital ID</span>
      <span className="block text-xs font-normal text-muted">มหาวิทยาลัยมหาสารคาม</span>
    </span>
  );
}

/** เส้นทองบาง 1px จางที่ปลายทั้งสองข้าง — ใช้แทนเส้นขอบล่างของ header (ตกแต่งเท่านั้น) */
function GoldHairline() {
  return <div aria-hidden className="h-px bg-linear-to-r from-transparent via-gold/70 to-transparent" />;
}

/**
 * โครงหน้าหลักของระบบ (mobile-first — docs/design/ui-guidelines.md หัวข้อ 4 และ 6)
 * - มือถือ: header + เนื้อหา + bottom nav
 * - tablet (md): navigation rail ซ้าย 80px
 * - desktop (lg): sidebar ซ้าย 256px
 */
export function PageShell({ children, title, backHref, user, width = 'wide', headerAction }: PageShellProps) {
  // แสดงเมนูเฉพาะผู้ใช้ที่ได้รับอนุมัติแล้ว
  const navUser = user?.approvalStatus === 'approved' ? user : null;
  const showNav = navUser !== null;
  const showBottomNav = showNav && !backHref;

  return (
    <div className={`min-h-dvh ${showNav ? 'md:pl-20 lg:pl-64' : ''}`}>
      {navUser && (
        <aside className="fixed inset-y-0 left-0 z-20 hidden w-20 flex-col border-r border-line bg-surface md:flex lg:w-64">
          <div className="flex h-14 items-center justify-center gap-2 border-b border-line lg:justify-start lg:px-5">
            <ShieldCheck className="size-7 shrink-0 text-gold" aria-hidden />
            <BrandName className="hidden text-sm lg:block" />
          </div>
          <nav aria-label="เมนูหลัก" className="flex-1 overflow-y-auto py-4">
            <NavLinks permissions={navUser.permissions} variant="side" />
          </nav>
        </aside>
      )}

      <header className="sticky top-0 z-10 bg-surface/95 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-2 md:px-4 lg:px-6">
          {backHref ? (
            <Link
              href={backHref}
              aria-label="ย้อนกลับ"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg hover:bg-surface-hover"
            >
              <ArrowLeft className="size-6" aria-hidden />
            </Link>
          ) : (
            // ไม่มีเมนูด้านข้าง (มือถือ/หน้าสาธารณะ) → แสดงโลโก้ใน header แทน
            <ShieldCheck className={`ml-2 size-7 shrink-0 text-gold ${showNav ? 'md:hidden' : ''}`} aria-hidden />
          )}

          <div className="min-w-0 flex-1 px-1">
            {title ? (
              <h1 className="truncate font-display text-lg font-semibold">{title}</h1>
            ) : (
              <p className="truncate">
                <BrandName className="text-base" />
              </p>
            )}
          </div>

          {headerAction}

          {navUser && (
            <Link
              href="/account"
              aria-label="บัญชีของฉัน"
              className="flex min-h-11 shrink-0 items-center gap-3 rounded-full p-1 hover:bg-surface-hover lg:pr-3"
            >
              <Avatar name={navUser.name} pictureUrl={navUser.pictureUrl} />
              <span className="hidden max-w-48 truncate text-sm font-medium lg:block">{navUser.name}</span>
            </Link>
          )}
        </div>
        <GoldHairline />
      </header>

      <main
        className={`mx-auto w-full px-4 py-6 md:px-6 lg:px-8 lg:py-8 ${width === 'form' ? 'max-w-2xl' : 'max-w-6xl'} ${
          showBottomNav ? 'pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-8' : ''
        }`}
      >
        {children}
      </main>

      {navUser && showBottomNav && (
        <nav
          aria-label="เมนูหลัก"
          className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <NavLinks permissions={navUser.permissions} variant="bottom" />
        </nav>
      )}
    </div>
  );
}
