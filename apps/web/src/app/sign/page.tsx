import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileBadge, History, KeyRound } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { BatchStatusBadge } from '@/components/signing/BatchStatusBadge';
import { DownloadButton, SignDocumentForm } from '@/components/signing/SignDocumentForm';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { getCurrentUser } from '@/lib/auth';
import { getMyCertificates } from '@/lib/certificates';
import { canSignWith, type SigningBatchSummary } from '@/lib/signing';
import { getMySigningBatches, getSigningPinStatus } from '@/lib/signing-batches';

export const metadata: Metadata = { title: 'ลงนามเอกสาร' };

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// ลงนาม PDF ด้วยใบรับรองของตัวเอง (document:sign — API ตรวจสิทธิ์ ใบ และ PIN อีกครั้งทุกครั้ง)
// docs/design/document-signing.md ระยะ D1: ไฟล์เดียว ลายมือชื่อแบบมองไม่เห็น เลือกล็อกเอกสารได้
export default async function SignPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('document:sign')) redirect('/forbidden');

  const [{ certificates }, pinStatus, batches, params] = await Promise.all([
    getMyCertificates(),
    getSigningPinStatus(),
    getMySigningBatches(),
    searchParams,
  ]);
  const usable = certificates.filter((c) => canSignWith(c));

  return (
    <PageShell title="ลงนามเอกสาร" user={user} width="form">
      <div className="space-y-8">
        {params.pin === 'updated' && <Alert tone="success">บันทึก PIN ลงนามใหม่แล้ว</Alert>}
        {usable.length === 0 ? (
          <StatusState
            icon={FileBadge}
            title="ยังไม่มีใบรับรองที่ใช้ลงนามได้"
            action={
              <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
                ไปที่ใบรับรองของฉัน
              </Link>
            }
          >
            ต้องมีใบรับรองที่ยังใช้งานได้และมี key สำรองในระบบ (ใบที่นำเข้าจากระบบเดิมโดยไม่มี key ใช้ลงนามบนเว็บไม่ได้)
          </StatusState>
        ) : (
          <SignDocumentForm certificates={usable} hasPin={pinStatus.hasPin} />
        )}
        <SigningHistory batches={batches} />
        {pinStatus.hasPin && (
          <div className="flex justify-center">
            <Link href="/sign/pin" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              <KeyRound className="size-5" aria-hidden />
              เปลี่ยน PIN ลงนาม
            </Link>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function SigningHistory({ batches }: { batches: SigningBatchSummary[] }) {
  return (
    <section className="space-y-3" aria-labelledby="signing-history">
      <div>
        <h2 id="signing-history" className="font-display text-lg font-semibold">
          ลงนามล่าสุด
        </h2>
        <p className="text-sm text-muted">ไฟล์ดาวน์โหลดได้ 7 วันหลังลงนาม แล้วระบบจะลบไฟล์ (เก็บไว้เฉพาะประวัติ)</p>
      </div>
      {batches.length === 0 ? (
        <StatusState icon={History} title="ยังไม่เคยลงนามเอกสาร">
          เอกสารที่ลงนามแล้วจะแสดงที่นี่
        </StatusState>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-card">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium break-all">{b.firstName ?? 'เอกสาร'}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <BatchStatusBadge status={b.status} />
                  {b.lockDocument && <Tag>ล็อกเอกสาร</Tag>}
                  <span className="tabular-nums">{dateTimeFormatter.format(new Date(b.createdAt))}</span>
                </p>
              </div>
              {b.firstSignedFileId ? (
                <DownloadButton fileId={b.firstSignedFileId} size="sm" />
              ) : (
                b.status === 'completed' && <span className="text-sm text-muted">ไฟล์ถูกลบแล้ว</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
