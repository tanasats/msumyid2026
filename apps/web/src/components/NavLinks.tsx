'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardCheck, FileBadge, House, UserRound, Users, type LucideIcon } from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** ต้องมี permission ใดใน list นี้จึงแสดงเมนู (ซ่อนเพื่อ UX เท่านั้น — API ตรวจสิทธิ์เสมอ) ไม่ระบุ = ทุกคนที่ login แล้ว */
  permission?: string | string[];
};

/**
 * เมนูหลักชุดเดียวใช้ทุกขนาดจอ: bottom nav (มือถือ) → rail (tablet) → sidebar (desktop)
 * เพิ่มเมนูเมื่อมีหน้าของฟังก์ชันนั้นจริง (ไม่เกิน 5 รายการเพราะ bottom nav แสดงได้เท่านั้น)
 * ป้ายต้องกว้างไม่เกิน 56px ที่ text-xs ตัวหนา (พื้นที่ข้อความของ rail บน tablet) ไม่เช่นนั้นจะตัดบรรทัดกลางคำ
 */
const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'หน้าหลัก', icon: House },
  { href: '/certificates', label: 'ใบรับรอง', icon: FileBadge },
  { href: '/admin/users', label: 'ผู้ใช้ระบบ', icon: Users, permission: 'user:read' },
  // คำขอที่รออนุมัติ (ใบประจำตัว + ใบเสริม = certificate:approve, เพิกถอน = certificate:revoke)
  // ผู้อนุมัติอาจไม่มีสิทธิ์ดูผู้ใช้/ใบรับรองทั้งหมด จึงต้องมีทางเข้าของตัวเอง
  {
    href: '/admin/certificate-requests',
    label: 'อนุมัติ',
    icon: ClipboardCheck,
    permission: ['certificate:approve', 'certificate:revoke'],
  },
  { href: '/account', label: 'โปรไฟล์', icon: UserRound },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

const VARIANT_CLASSES = {
  // มือถือ: ไอคอนบน ป้ายล่าง แบ่งความกว้างเท่ากัน
  bottom: {
    list: 'flex',
    item: 'flex min-h-16 flex-1 flex-col items-center justify-center gap-1 px-1 text-xs',
  },
  // tablet: rail แคบ (ไอคอนบน ป้ายล่าง) / desktop: sidebar (ไอคอนกับป้ายแถวเดียวกัน)
  side: {
    list: 'flex flex-col gap-1 px-2 lg:px-3',
    item: 'flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 text-xs lg:min-h-11 lg:flex-row lg:justify-start lg:gap-3 lg:px-3 lg:text-sm',
  },
} as const;

export function NavLinks({ permissions, variant }: { permissions: string[]; variant: 'bottom' | 'side' }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter(
    (item) => !item.permission || [item.permission].flat().some((p) => permissions.includes(p)),
  );
  const classes = VARIANT_CLASSES[variant];

  return (
    <ul className={classes.list}>
      {items.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <li key={href} className={variant === 'bottom' ? 'flex-1' : undefined}>
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`${classes.item} transition ${
                active
                  ? 'font-semibold text-accent-soft-fg' +
                    // sidebar: พื้นน้ำเงินอ่อน + แถบสีหมึกด้านซ้าย
                    (variant === 'side'
                      ? ' relative bg-accent-soft before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary'
                      : '')
                  : 'text-muted hover:bg-surface-hover hover:text-fg'
              }`}
            >
              {/* bottom nav: รายการที่เลือกมีพื้นหลังรูปแคปซูลรอบไอคอน */}
              <span
                className={
                  variant === 'bottom'
                    ? `flex h-8 w-14 items-center justify-center rounded-full ${active ? 'bg-accent-soft' : ''}`
                    : 'flex'
                }
              >
                <Icon className="size-6 lg:size-5" aria-hidden />
              </span>
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
