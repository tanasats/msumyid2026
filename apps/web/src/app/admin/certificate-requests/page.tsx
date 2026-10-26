import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Filter, Inbox, SearchX } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { AdminPrimaryRequestCard } from '@/components/certificates/AdminPrimaryRequestCard';
import { AdminSupplementaryRequestCard } from '@/components/certificates/AdminSupplementaryRequestCard';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { listAdminPrimaryRequests } from '@/lib/primary-certificate-requests';
import { SUPPLEMENTARY_STATUS_LABELS } from '@/lib/supplementary-certificate';
import { listAdminSupplementaryRequests, type AdminRequestView } from '@/lib/supplementary-certificates';

export const metadata: Metadata = { title: 'คำขอใบรับรอง' };

type RequestType = 'primary' | 'supplementary';

const TYPE_LABELS: Record<RequestType, string> = { primary: 'ใบประจำตัว', supplementary: 'ใบเสริม' };

// ตัวกรองของแท็บประวัติ (คำขอที่ตัดสินหรือปิดไปแล้ว) — สถานะชุดเดียวกันทั้งสองประเภท
const HISTORY_OPTIONS: { value: Exclude<AdminRequestView, 'pending'>; label: string }[] = [
  { value: 'all', label: 'ทุกสถานะ' },
  { value: 'approved', label: SUPPLEMENTARY_STATUS_LABELS.approved },
  { value: 'issued', label: SUPPLEMENTARY_STATUS_LABELS.issued },
  { value: 'rejected', label: SUPPLEMENTARY_STATUS_LABELS.rejected },
  { value: 'cancelled', label: SUPPLEMENTARY_STATUS_LABELS.cancelled },
  { value: 'expired', label: SUPPLEMENTARY_STATUS_LABELS.expired },
];

const tabClass = (active: boolean) =>
  `flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-sm font-medium transition ${
    active ? 'bg-surface text-accent-soft-fg shadow-card ring-1 ring-ornament/60' : 'text-muted hover:text-fg'
  }`;

// คำขอใบรับรองประจำตัวและใบรับรองเสริม (ต้องมี certificate:approve — API ตรวจ ส่วนเว็บซ่อนลิงก์เท่านั้น)
export default async function AdminCertificateRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);
  if (!user.permissions.includes('certificate:approve')) redirect('/forbidden');

  const params = await searchParams;
  const type: RequestType = params.type === 'supplementary' ? 'supplementary' : 'primary';
  const view: AdminRequestView = HISTORY_OPTIONS.find((o) => o.value === params.view)?.value ?? 'pending';
  const cursor = view !== 'pending' && typeof params.cursor === 'string' ? params.cursor : undefined;

  // ประเภทที่เลือกดึงตามมุมมอง อีกประเภทดึงเฉพาะจำนวนที่รอ (คิวรออนุมัติจำกัด 100 รายการอยู่แล้ว)
  const [primary, supplementary] = await Promise.all([
    listAdminPrimaryRequests(type === 'primary' ? { view, cursor } : { view: 'pending' }),
    listAdminSupplementaryRequests(type === 'supplementary' ? { view, cursor } : { view: 'pending' }),
  ]);
  const current = type === 'primary' ? primary : supplementary;
  const pendingCount = current.pendingCount;

  const canViewRequester = user.permissions.includes('user:read');
  const backHref = user.permissions.includes('certificate:read') ? '/admin/certificates' : '/';
  const isHistory = view !== 'pending';
  const href = (query: Record<string, string>) => `/admin/certificate-requests?${new URLSearchParams({ type, ...query })}`;

  return (
    <PageShell title="คำขอใบรับรอง" backHref={backHref} user={user}>
      <div className="space-y-4">
        <nav aria-label="ประเภทคำขอ" className="flex w-full max-w-md rounded-full border border-line bg-canvas p-1">
          {(['primary', 'supplementary'] as const).map((t) => (
            <Link
              key={t}
              href={`/admin/certificate-requests?type=${t}`}
              aria-current={type === t ? 'page' : undefined}
              className={tabClass(type === t)}
            >
              {TYPE_LABELS[t]} ({(t === 'primary' ? primary : supplementary).pendingCount})
            </Link>
          ))}
        </nav>
        <nav aria-label="มุมมอง" className="flex w-full max-w-md rounded-full border border-line bg-canvas p-1">
          <Link href={href({})} aria-current={!isHistory ? 'page' : undefined} className={tabClass(!isHistory)}>
            รออนุมัติ ({pendingCount})
          </Link>
          <Link href={href({ view: 'all' })} aria-current={isHistory ? 'page' : undefined} className={tabClass(isHistory)}>
            ประวัติ
          </Link>
        </nav>

        {isHistory && (
          // ฟอร์มกรองแบบ GET — ทำงานได้โดยไม่ต้องใช้ JavaScript และแชร์ลิงก์ได้
          <form method="get" className="space-y-3 rounded-xl border border-line bg-surface shadow-card p-4 sm:flex sm:items-end sm:gap-3 sm:space-y-0">
            <input type="hidden" name="type" value={type} />
            <div className="flex-1 space-y-1.5">
              <label htmlFor="view" className="block text-sm font-medium">
                สถานะ
              </label>
              <select
                id="view"
                name="view"
                defaultValue={view}
                className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base"
              >
                {HISTORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={`${buttonClasses({ variant: 'secondary', fullWidth: true })} w-full sm:w-auto`}>
              <Filter className="size-5" aria-hidden />
              กรอง
            </button>
          </form>
        )}

        {current.requests.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface shadow-card">
            {isHistory ? (
              <StatusState icon={SearchX} title="ไม่พบคำขอตามสถานะนี้">
                ลองเลือกสถานะอื่น
              </StatusState>
            ) : (
              <StatusState icon={Inbox} title="ไม่มีคำขอที่รออนุมัติ">
                คำขอ{TYPE_LABELS[type]}ใหม่จะแสดงที่นี่ เรียงจากคำขอที่รอนานที่สุด
              </StatusState>
            )}
          </div>
        ) : (
          <>
            {!isHistory && pendingCount > current.requests.length && (
              <p className="text-sm text-muted">
                แสดง {current.requests.length} คำขอที่รอนานที่สุดจากทั้งหมด {pendingCount} คำขอ
              </p>
            )}
            <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
              {type === 'primary'
                ? primary.requests.map((r) => (
                    <AdminPrimaryRequestCard key={r.id} request={r} canViewRequester={canViewRequester} />
                  ))
                : supplementary.requests.map((r) => (
                    <AdminSupplementaryRequestCard
                      key={r.id}
                      request={r}
                      limits={supplementary.limits}
                      canViewRequester={canViewRequester}
                    />
                  ))}
            </ul>
          </>
        )}

        {isHistory && (current.nextCursor || cursor) && (
          <nav aria-label="แบ่งหน้า" className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            {cursor ? (
              <Link href={href({ view })} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                กลับหน้าแรก
              </Link>
            ) : (
              <span />
            )}
            {current.nextCursor && (
              <Link href={href({ view, cursor: current.nextCursor })} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                หน้าถัดไป
              </Link>
            )}
          </nav>
        )}
      </div>
    </PageShell>
  );
}
