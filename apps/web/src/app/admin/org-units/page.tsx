import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Building2, CircleCheck, Search, SearchX } from 'lucide-react';
import { ErpOrgUnitActions } from '@/components/admin/ErpOrgUnitActions';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { listErpOrgUnits, type ErpOrgUnitQuery } from '@/lib/admin-erp-org-units';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { LEVEL_LABELS, MATCH_TYPE_LABELS, type ErpOrgUnitLevel, type ErpOrgUnitStatus } from '@/lib/erp-org-unit';

export const metadata: Metadata = { title: 'จับคู่หน่วยงาน ERP' };

const numberFormatter = new Intl.NumberFormat('th-TH');

const STATUS_TABS: { value: ErpOrgUnitStatus; label: string }[] = [
  { value: 'unmatched', label: 'ยังไม่จับคู่' },
  { value: 'auto', label: 'อัตโนมัติ' },
  { value: 'manual', label: 'กำหนดเอง' },
  { value: 'all', label: 'ทั้งหมด' },
];

const LEVEL_OPTIONS = [
  { value: '', label: 'ทุกระดับ' },
  { value: 'faculty', label: LEVEL_LABELS.faculty },
  { value: 'department', label: LEVEL_LABELS.department },
] as const;

const EMPTY_TEXT: Record<ErpOrgUnitStatus, { title: string; detail: string }> = {
  unmatched: { title: 'จับคู่ครบทุกหน่วยงานแล้ว', detail: 'หน่วยงานใหม่จาก ERP จะแสดงที่นี่เมื่อบุคลากรเข้าสู่ระบบ' },
  auto: { title: 'ยังไม่มีหน่วยงานที่ระบบจับคู่ให้', detail: 'ระบบจับคู่เมื่อชื่อใน ERP ตรงกับชื่อหน่วยงานในระบบพอดี' },
  manual: { title: 'ยังไม่มีหน่วยงานที่กำหนดเอง', detail: 'กด "จับคู่" หรือ "เปลี่ยน" ที่หน่วยงานในแท็บอื่น' },
  all: { title: 'ยังไม่มีหน่วยงานจาก ERP', detail: 'ระบบบันทึกหน่วยงานเมื่อบุคลากรเข้าสู่ระบบครั้งแรก' },
};

const tabClass = (active: boolean) =>
  `flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-sm font-medium transition ${
    active ? 'bg-surface text-accent-soft-fg shadow-card ring-1 ring-ornament/60' : 'text-muted hover:text-fg'
  }`;

// จับคู่หน่วยงาน ERP กับหน่วยงานในระบบ (ต้องมี org_unit:manage — API ตรวจ ส่วนเว็บซ่อนเมนูเท่านั้น)
export default async function ErpOrgUnitsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);
  if (!user.permissions.includes('org_unit:manage')) redirect('/forbidden');

  const params = await searchParams;
  const status = STATUS_TABS.find((t) => t.value === params.status)?.value ?? 'unmatched';
  const level =
    params.level === 'faculty' || params.level === 'department' ? (params.level as ErpOrgUnitLevel) : undefined;
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 100) || undefined : undefined;
  const pageNumber = Math.min(Math.max(Number.parseInt(String(params.page ?? '1'), 10) || 1, 1), 1000);
  const query: ErpOrgUnitQuery = { status, level, q, page: pageNumber };
  const data = await listErpOrgUnits(query);

  const href = (overrides: Partial<ErpOrgUnitQuery>) => {
    const next = { ...query, page: 1, ...overrides };
    const search = new URLSearchParams({ status: next.status });
    if (next.level) search.set('level', next.level);
    if (next.q) search.set('q', next.q);
    if (next.page > 1) search.set('page', String(next.page));
    return `/admin/org-units?${search}`;
  };
  const lastPage = Math.max(Math.ceil(data.total / data.pageSize), 1);
  const empty = q || level ? { title: 'ไม่พบหน่วยงานตามเงื่อนไข', detail: 'ลองเปลี่ยนคำค้นหาหรือระดับ' } : EMPTY_TEXT[status];

  return (
    <PageShell title="จับคู่หน่วยงาน ERP" backHref="/admin" user={user}>
      <div className="space-y-4">
        <p className="text-muted">
          ระบบจับคู่หน่วยงานจาก ERP-HR กับหน่วยงานในระบบให้เองเมื่อชื่อตรงกันพอดี ส่วนที่ชื่อไม่ตรงให้จับคู่ที่นี่
          หน่วยงานของบุคลากรใช้ของกอง/ฝ่ายก่อน ถ้าไม่มีจึงใช้ของคณะ/สำนัก
        </p>

        <nav aria-label="สถานะการจับคู่" className="flex w-full max-w-xl rounded-full border border-line bg-canvas p-1">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              href={href({ status: t.value })}
              aria-current={status === t.value ? 'page' : undefined}
              className={tabClass(status === t.value)}
            >
              {t.label}
              {t.value === 'unmatched' && ` (${numberFormatter.format(data.unmatchedCount)})`}
            </Link>
          ))}
        </nav>

        {/* ฟอร์มค้นหาแบบ GET — ทำงานได้โดยไม่ต้องใช้ JavaScript และแชร์ลิงก์ผลค้นหาได้ */}
        <form
          method="get"
          className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-card lg:flex lg:items-end lg:gap-3 lg:space-y-0"
        >
          <input type="hidden" name="status" value={status} />
          <div className="flex-1 space-y-1.5">
            <label htmlFor="q" className="block text-sm font-medium">
              ค้นหา
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="ชื่อหน่วยงาน หรือ รหัส ERP"
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base placeholder:text-subtle"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="level" className="block text-sm font-medium">
              ระดับ
            </label>
            <select
              id="level"
              name="level"
              defaultValue={level ?? ''}
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base lg:w-44"
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={`${buttonClasses({ fullWidth: true })} w-full lg:w-auto`}>
            <Search className="size-5" aria-hidden />
            ค้นหา
          </button>
        </form>

        {data.items.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface shadow-card">
            <StatusState icon={q || level ? SearchX : status === 'unmatched' ? CircleCheck : Building2} title={empty.title}>
              {empty.detail}
            </StatusState>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-card">
            {data.items.map((item) => (
              <li key={item.id} className="space-y-3 p-4 sm:p-5 lg:grid lg:grid-cols-[1fr_1fr] lg:gap-6 lg:space-y-0">
                <div className="min-w-0">
                  <p className="font-medium">{item.nameTh}</p>
                  <p className="mt-0.5 text-sm text-muted tabular-nums">
                    {item.erpCode} · {LEVEL_LABELS[item.level]} · บุคลากร {numberFormatter.format(item.staffCount)} คน
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="text-muted">หน่วยงานในระบบ:</span>
                    {item.orgUnit ? (
                      <>
                        <span className="font-medium">
                          {item.orgUnit.nameTh} ({item.orgUnit.code})
                        </span>
                        {item.matchType && <Tag strong={item.matchType === 'manual'}>{MATCH_TYPE_LABELS[item.matchType]}</Tag>}
                      </>
                    ) : (
                      <Tag>ยังไม่จับคู่</Tag>
                    )}
                  </div>
                </div>
                <ErpOrgUnitActions item={item} orgUnits={data.orgUnits} />
              </li>
            ))}
          </ul>
        )}

        {lastPage > 1 && (
          <nav aria-label="แบ่งหน้า" className="flex flex-col-reverse items-center gap-3 sm:flex-row sm:justify-between">
            {pageNumber > 1 ? (
              <Link href={href({ page: pageNumber - 1 })} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                หน้าก่อนหน้า
              </Link>
            ) : (
              <span />
            )}
            <span className="text-sm text-muted tabular-nums">
              หน้า {numberFormatter.format(pageNumber)} จาก {numberFormatter.format(lastPage)}
            </span>
            {pageNumber < lastPage ? (
              <Link href={href({ page: pageNumber + 1 })} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                หน้าถัดไป
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </div>
    </PageShell>
  );
}
