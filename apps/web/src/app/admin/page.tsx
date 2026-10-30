import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  CalendarClock,
  ChevronRight,
  CircleCheck,
  CircleX,
  ClipboardCheck,
  FileBadge,
  KeyRound,
  Settings,
  TriangleAlert,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { getDashboard, type Dashboard, type HealthLevel } from '@/lib/admin-dashboard';
import { getCurrentUser, redirectUnlessReady, type CurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'จัดการระบบ' };

const numberFormatter = new Intl.NumberFormat('th-TH');
const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});
const HOUR_MS = 60 * 60 * 1000;

// สิทธิ์ที่ทำให้ API มีหมวดให้ (ตรงกับ dashboard-service) — มีแค่ certificate_policy:manage = มีแต่ทางลัด ไม่ต้องเรียก API
const DASHBOARD_PERMISSIONS = ['user:approve', 'certificate:approve', 'certificate:revoke', 'user:read', 'certificate:read'];

/**
 * หน้า "จัดการระบบ" (ตัดสินใจ 2026-10-30): งานที่รอ → สถานะระบบ → ภาพรวม → เครื่องมือ
 * แต่ละส่วนแสดงตามสิทธิ์ (API ตรวจอีกครั้งและคืนเฉพาะหมวดที่มีสิทธิ์) super_admin เห็นครบ
 */
export default async function AdminDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);

  const tools = toolsFor(user);
  const hasSection =
    user.capabilities.manageSettings || DASHBOARD_PERMISSIONS.some((p) => user.permissions.includes(p));
  if (!hasSection && tools.length === 0) redirect('/forbidden');
  const data = hasSection ? await getDashboard() : null;
  const now = Date.now();

  return (
    <PageShell title="จัดการระบบ" user={user}>
      <div className="space-y-6">
        {data && <PendingWork pending={data.pending} />}

        {data && (data.system || data.users || data.certificates) && (
          <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
            {data.system && <SystemStatus system={data.system} now={now} />}
            {data.users && <UserSummary users={data.users} windowDays={data.windowDays} />}
            {data.certificates && <CertificateSummary certificates={data.certificates} windowDays={data.windowDays} />}
          </div>
        )}

        {tools.length > 0 && (
          <section aria-labelledby="admin-tools">
            <h2 id="admin-tools" className="mb-3 font-display text-lg font-semibold">
              เครื่องมือผู้ดูแล
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tools.map(({ href, icon: Icon, title, detail }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="group flex h-full min-h-16 items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-card transition hover:border-line-input hover:bg-surface-hover"
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
          </section>
        )}
      </div>
    </PageShell>
  );
}

type Tool = { href: string; icon: LucideIcon; title: string; detail: string };

/** ทางลัดไปหน้าจัดการที่ผู้ใช้มีสิทธิ์ (ซ่อนเพื่อ UX — ทุกหน้าตรวจสิทธิ์ที่ API) */
function toolsFor(user: CurrentUser): Tool[] {
  const can = (p: string) => user.permissions.includes(p);
  const tools: (Tool | false)[] = [
    can('user:read') && { href: '/admin/users', icon: Users, title: 'ผู้ใช้', detail: 'ค้นหา อนุมัติบัญชี และจัดการบทบาทของผู้ใช้' },
    can('user:create') && {
      href: '/admin/users/new',
      icon: UserPlus,
      title: 'ลงทะเบียนผู้ใช้',
      detail: 'เพิ่มบัญชีล่วงหน้าด้วยอีเมล ก่อนเจ้าของเข้าระบบครั้งแรก',
    },
    can('certificate:read') && {
      href: '/admin/certificates',
      icon: FileBadge,
      title: 'ใบรับรองทั้งหมด',
      detail: 'ค้นหาใบรับรองของผู้ใช้ ดูประวัติ และเพิกถอน',
    },
    (can('certificate:approve') || can('certificate:revoke')) && {
      href: '/admin/certificate-requests',
      icon: ClipboardCheck,
      title: 'คำขอที่รออนุมัติ',
      detail: 'คำขอใบรับรองประจำตัว ใบรับรองเสริม และคำขอเพิกถอน',
    },
    can('certificate_policy:manage') && {
      href: '/admin/certificate-policy',
      icon: CalendarClock,
      title: 'นโยบายอายุใบรับรอง',
      detail: 'อายุใบรับรองประจำตัว ช่วงต่ออายุ และเพดานของใบรับรองเสริม',
    },
    user.capabilities.manageRoles && {
      href: '/admin/roles',
      icon: KeyRound,
      title: 'บทบาทและสิทธิ์',
      detail: 'สร้างบทบาทและกำหนดว่าแต่ละบทบาททำอะไรได้',
    },
    user.capabilities.manageSettings && {
      href: '/admin/settings',
      icon: Settings,
      title: 'ตั้งค่าระบบ',
      detail: 'โดเมนที่ไม่ต้องรออนุมัติ อายุการเข้าระบบ รอบออก CRL และโควตาขอใบใหม่',
    },
  ];
  return tools.filter((t): t is Tool => t !== false);
}

type PendingItem = { key: string; count: number; label: string; href: string };

/** ส่วนที่เด่นที่สุดของหน้า: คิวที่รอผู้ดูแล — ช่องที่มีงานใช้ตัวเลขเข้ม ช่องว่างใช้สีจาง */
function PendingWork({ pending }: { pending: Dashboard['pending'] }) {
  const items: PendingItem[] = [
    { key: 'userApprovals', count: pending.userApprovals, label: 'บัญชีรออนุมัติ', href: '/admin/users?status=pending' },
    {
      key: 'primaryRequests',
      count: pending.primaryRequests,
      label: 'คำขอใบรับรองประจำตัว',
      href: '/admin/certificate-requests?type=primary',
    },
    {
      key: 'supplementaryRequests',
      count: pending.supplementaryRequests,
      label: 'คำขอใบรับรองเสริม',
      href: '/admin/certificate-requests?type=supplementary',
    },
    {
      key: 'revocationRequests',
      count: pending.revocationRequests,
      label: 'คำขอเพิกถอน',
      href: '/admin/certificate-requests?type=revocation',
    },
  ].filter((item): item is PendingItem => item.count !== undefined);
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return (
    <section aria-labelledby="pending-work" className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="pending-work" className="font-display text-lg font-semibold">
          รอดำเนินการ
        </h2>
        <p className="text-sm text-muted">
          {total === 0 ? 'ไม่มีงานค้าง' : `ทั้งหมด ${numberFormatter.format(total)} รายการ`}
        </p>
      </div>
      <ul className={`mt-4 grid grid-cols-2 gap-3 ${items.length >= 4 ? 'lg:grid-cols-4' : items.length === 3 ? 'lg:grid-cols-3' : ''}`}>
        {items.map((item) => {
          const hasWork = item.count > 0;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                className={`group flex h-full min-h-24 flex-col justify-between rounded-lg border p-4 transition ${
                  hasWork
                    ? 'border-accent/40 bg-accent-soft hover:border-accent'
                    : 'border-line hover:border-line-input hover:bg-surface-hover'
                }`}
              >
                <span
                  className={`text-4xl leading-none font-semibold tabular-nums ${hasWork ? 'text-accent-soft-fg' : 'text-subtle'}`}
                >
                  {numberFormatter.format(item.count)}
                </span>
                <span className="mt-3 flex items-end justify-between gap-2 text-sm">
                  <span className={hasWork ? 'font-medium' : 'text-muted'}>{item.label}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted transition group-hover:translate-x-0.5" aria-hidden />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const LEVELS: Record<HealthLevel, { icon: LucideIcon; tone: string; word: string }> = {
  ok: { icon: CircleCheck, tone: 'text-success-fg', word: 'ปกติ' },
  warning: { icon: TriangleAlert, tone: 'text-warning-fg', word: 'ต้องตรวจ' },
  error: { icon: CircleX, tone: 'text-danger-fg', word: 'ใช้งานไม่ได้' },
};

/** แถวสถานะ: ไอคอน + คำบอกสถานะ (ไม่สื่อด้วยสีอย่างเดียว) + รายละเอียด */
function StatusRow({ level, label, children }: { level: HealthLevel; label: string; children: React.ReactNode }) {
  const { icon: Icon, tone, word } = LEVELS[level];
  return (
    <li className="flex gap-3 py-3">
      <Icon className={`mt-0.5 size-5 shrink-0 ${tone}`} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium">{label}</span>
          <span className={`font-medium ${tone}`}>{word}</span>
        </p>
        <div className="mt-0.5 text-muted">{children}</div>
      </div>
    </li>
  );
}

function remaining(ms: number): string {
  if (ms <= 0) return 'หมดอายุแล้ว';
  const hours = Math.floor(ms / HOUR_MS);
  return hours < 48 ? `อีก ${hours} ชั่วโมง` : `อีก ${Math.floor(hours / 24)} วัน`;
}

function SystemStatus({ system, now }: { system: NonNullable<Dashboard['system']>; now: number }) {
  const { crl, signingQueue: queue } = system;
  const overall: HealthLevel = [system.signer, crl.level, queue.level].includes('error')
    ? 'error'
    : [system.signer, crl.level, queue.level].includes('warning')
      ? 'warning'
      : 'ok';

  return (
    <section aria-labelledby="system-status" className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 id="system-status" className="font-display text-lg font-semibold">
        สถานะระบบ
      </h2>
      <p className="mt-1 text-sm text-muted">
        {overall === 'ok' ? 'ทุกส่วนทำงานปกติ' : 'มีส่วนที่ต้องตรวจ ดูรายละเอียดด้านล่าง'}
      </p>
      <ul className="mt-2 divide-y divide-line">
        <StatusRow level={system.signer} label="บริการเซ็น">
          {system.signer === 'ok' ? 'พร้อมออกใบรับรองและลงนาม' : 'ติดต่อไม่ได้ ออกใบรับรองและลงนามเอกสารไม่ได้'}
        </StatusRow>
        <StatusRow level={crl.level} label="รายการเพิกถอน (CRL)">
          {crl.crlNumber && crl.nextUpdate ? (
            <>
              <span className="block">
                เลข <span className="font-mono text-xs">{crl.crlNumber}</span>
              </span>
              <span className="block tabular-nums">
                ใช้ได้ถึง {dateTimeFormatter.format(new Date(crl.nextUpdate))} ({remaining(new Date(crl.nextUpdate).getTime() - now)})
              </span>
              {crl.level !== 'ok' && <span className="block">ระบบควรออกฉบับใหม่ตามรอบ ตรวจ log ของ API</span>}
            </>
          ) : (
            'ยังไม่เคยออก CRL'
          )}
        </StatusRow>
        <StatusRow level={queue.level} label="คิวลงนามเอกสาร">
          <span className="block tabular-nums">
            รอคิว {numberFormatter.format(queue.pending)} ไฟล์ กำลังลงนาม {numberFormatter.format(queue.signing)} ไฟล์
          </span>
          <span className="block tabular-nums">ล้มเหลวใน 24 ชั่วโมง {numberFormatter.format(queue.failedLast24h)} ไฟล์</span>
          {queue.level !== 'ok' && queue.oldestOpenAt && (
            <span className="block">
              มีงานค้างตั้งแต่ {dateTimeFormatter.format(new Date(queue.oldestOpenAt))} ตรวจว่า worker ทำงานอยู่
            </span>
          )}
        </StatusRow>
      </ul>
    </section>
  );
}

/** กล่องสถิติ: รายการตัวเลขชิดขวา + ลิงก์ไปหน้าจัดการของหมวดนั้น */
function StatSection({
  id,
  title,
  rows,
  link,
}: {
  id: string;
  title: string;
  rows: { label: string; value: number; href?: string }[];
  link: { href: string; label: string };
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 id={id} className="font-display text-lg font-semibold">
        {title}
      </h2>
      <dl className="mt-3 divide-y divide-line text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-4 py-3">
            <dt className="text-muted">
              {row.href ? (
                <Link href={row.href} className="text-accent hover:underline">
                  {row.label}
                </Link>
              ) : (
                row.label
              )}
            </dt>
            <dd className="text-base font-semibold tabular-nums">{numberFormatter.format(row.value)}</dd>
          </div>
        ))}
      </dl>
      <Link
        href={link.href}
        className="mt-auto inline-flex min-h-11 items-center gap-1 self-start pt-3 text-sm font-medium text-accent hover:underline"
      >
        {link.label}
        <ChevronRight className="size-4" aria-hidden />
      </Link>
    </section>
  );
}

function UserSummary({ users, windowDays }: { users: NonNullable<Dashboard['users']>; windowDays: number }) {
  return (
    <StatSection
      id="user-summary"
      title="ผู้ใช้"
      rows={[
        { label: 'ใช้งานได้', value: users.active, href: '/admin/users?status=active' },
        { label: `บัญชีใหม่ใน ${windowDays} วัน`, value: users.createdSince },
        { label: 'รอจำแนกประเภท', value: users.unclassified, href: '/admin/users?accountType=unclassified' },
        { label: 'ปิดบัญชี', value: users.inactive, href: '/admin/users?status=inactive' },
      ]}
      link={{ href: '/admin/users', label: 'จัดการผู้ใช้' }}
    />
  );
}

function CertificateSummary({
  certificates,
  windowDays,
}: {
  certificates: NonNullable<Dashboard['certificates']>;
  windowDays: number;
}) {
  return (
    <StatSection
      id="certificate-summary"
      title="ใบรับรอง"
      rows={[
        { label: 'ใบประจำตัวที่ใช้งานได้', value: certificates.activePrimary },
        { label: 'ใบเสริมที่ใช้งานได้', value: certificates.activeSupplementary },
        { label: `หมดอายุภายใน ${windowDays} วัน`, value: certificates.expiringSoon },
        { label: `ออกใหม่ใน ${windowDays} วัน`, value: certificates.issuedSince },
        { label: `เพิกถอนใน ${windowDays} วัน`, value: certificates.revokedSince },
      ]}
      link={{ href: '/admin/certificates', label: 'ใบรับรองทั้งหมด' }}
    />
  );
}
