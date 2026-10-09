import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Search, SearchX } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { AdminCertificateCard } from '@/components/certificates/AdminCertificateCard';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { searchAdminCertificates, type AdminCertificateQuery } from '@/lib/admin-certificates';
import { getCurrentUser } from '@/lib/auth';
import { CERTIFICATE_STATUS_LABELS, type CertificateStatus } from '@/lib/certificate';

export const metadata: Metadata = { title: 'ใบรับรองทั้งหมด' };

const STATUS_OPTIONS: { value: '' | CertificateStatus; label: string }[] = [
  { value: '', label: 'ทุกสถานะ' },
  { value: 'active', label: CERTIFICATE_STATUS_LABELS.active },
  { value: 'expired', label: CERTIFICATE_STATUS_LABELS.expired },
  { value: 'revoked', label: CERTIFICATE_STATUS_LABELS.revoked },
];

// ใบรับรองทั้งระบบ (ต้องมี certificate:read — API ตรวจ ส่วนเว็บซ่อนลิงก์เท่านั้น)
export default async function AdminCertificatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('certificate:read')) redirect('/forbidden');

  const params = await searchParams;
  const status = STATUS_OPTIONS.find((o) => o.value && o.value === params.status)?.value || undefined;
  const query: AdminCertificateQuery = {
    q: typeof params.q === 'string' ? params.q.trim().slice(0, 100) || undefined : undefined,
    status,
    cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
  };
  const { certificates, nextCursor } = await searchAdminCertificates(query);

  const canRevoke = user.permissions.includes('certificate:revoke');
  const canViewOwner = user.permissions.includes('user:read');

  // ลิงก์หน้าถัดไปคงตัวกรองเดิมไว้
  const filterParams = new URLSearchParams();
  if (query.q) filterParams.set('q', query.q);
  if (query.status) filterParams.set('status', query.status);
  const nextHref = nextCursor
    ? `/admin/certificates?${new URLSearchParams([...filterParams, ['cursor', nextCursor]])}`
    : null;

  return (
    <PageShell title="ใบรับรองทั้งหมด" backHref={canViewOwner ? '/admin/users' : undefined} user={user}>
      <div className="space-y-4">
        {/* ฟอร์มค้นหาแบบ GET — ทำงานได้โดยไม่ต้องใช้ JavaScript และแชร์ลิงก์ผลค้นหาได้ */}
        <form method="get" className="space-y-3 rounded-xl border border-line bg-surface shadow-card p-4 lg:flex lg:items-end lg:gap-3 lg:space-y-0">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="q" className="block text-sm font-medium">
              ค้นหา
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder="ชื่อ อีเมล หรือหมายเลขใบรับรอง"
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base placeholder:text-subtle"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="status" className="block text-sm font-medium">
              สถานะ
            </label>
            <select
              id="status"
              name="status"
              defaultValue={query.status ?? ''}
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base lg:w-44"
            >
              {STATUS_OPTIONS.map((o) => (
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

        {certificates.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface shadow-card">
            <StatusState icon={SearchX} title="ไม่พบใบรับรองตามเงื่อนไข">
              ลองเปลี่ยนคำค้นหาหรือสถานะ
            </StatusState>
          </div>
        ) : (
          <ul className="space-y-3">
            {certificates.map((c) => (
              <AdminCertificateCard
                key={c.id}
                certificate={c}
                owner={c.owner}
                canRevoke={canRevoke}
                canViewOwner={canViewOwner}
              />
            ))}
          </ul>
        )}

        {(nextHref || query.cursor) && (
          <nav aria-label="แบ่งหน้า" className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            {query.cursor ? (
              <Link
                href={`/admin/certificates?${filterParams}`}
                className={buttonClasses({ variant: 'secondary', fullWidth: true })}
              >
                กลับหน้าแรก
              </Link>
            ) : (
              <span />
            )}
            {nextHref && (
              <Link href={nextHref} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                หน้าถัดไป
              </Link>
            )}
          </nav>
        )}
      </div>
    </PageShell>
  );
}
