import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, FileArchive, FileBadge, History, KeyRound, Signature } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { BatchStatusBadge } from '@/components/signing/BatchStatusBadge';
import { DownloadButton } from '@/components/signing/DownloadButton';
import { SignDocumentForm } from '@/components/signing/SignDocumentForm';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { getCurrentUser } from '@/lib/auth';
import { getMyCertificates } from '@/lib/certificates';
import { canSignWith, type SigningBatchSummary } from '@/lib/signing';
import { getMySignatureImage, getMySigningBatches, getSigningPinStatus } from '@/lib/signing-batches';

export const metadata: Metadata = { title: 'ลงนามเอกสาร' };

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// ลงนาม PDF ด้วยใบรับรองของตัวเอง (document:sign — API ตรวจสิทธิ์ ใบ และ PIN อีกครั้งทุกครั้ง)
// docs/design/document-signing.md ระยะ D1–D3: PDF ไฟล์เดียวหรือ ZIP หลายไฟล์ แสดงลายเซ็น (ภาพ/ชื่อและวันเวลา) ณ ตำแหน่งที่ลากวาง
// หรือไม่แสดง เลือกล็อกเอกสารได้ — ผลการลงนามแต่ละชุดอยู่ที่ /sign/batches/[id]
export default async function SignPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('document:sign')) redirect('/forbidden');

  const [{ certificates }, pinStatus, batches, signatureImage, params] = await Promise.all([
    getMyCertificates(),
    getSigningPinStatus(),
    getMySigningBatches(),
    getMySignatureImage(),
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
          <SignDocumentForm
            certificates={usable}
            hasPin={pinStatus.hasPin}
            signatureImage={signatureImage}
            signerName={user.name}
          />
        )}
        <SigningHistory batches={batches} />
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/sign/signature" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            <Signature className="size-5" aria-hidden />
            {signatureImage ? 'เปลี่ยนภาพลายเซ็น' : 'ตั้งภาพลายเซ็น'}
          </Link>
          {pinStatus.hasPin && (
            <Link href="/sign/pin" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
              <KeyRound className="size-5" aria-hidden />
              เปลี่ยน PIN ลงนาม
            </Link>
          )}
        </div>
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
              <Link href={`/sign/batches/${b.id}`} className="group min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-medium break-all group-hover:underline">
                  {b.source === 'zip' && <FileArchive className="size-4 shrink-0" aria-hidden />}
                  {b.firstName ?? 'เอกสาร'}
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <BatchStatusBadge status={b.status} />
                  {b.source === 'zip' && b.totalJobs > 0 && (
                    <span className="tabular-nums">
                      {b.signedJobs}/{b.totalJobs} ไฟล์
                    </span>
                  )}
                  {b.lockDocument && <Tag>ล็อกเอกสาร</Tag>}
                  <span className="tabular-nums">{dateTimeFormatter.format(new Date(b.createdAt))}</span>
                </p>
              </Link>
              {b.source === 'single' && b.firstSignedFileId ? (
                <DownloadButton fileId={b.firstSignedFileId} size="sm" />
              ) : (
                b.status === 'completed' && !b.firstSignedFileId && <span className="text-sm text-muted">ไฟล์ถูกลบแล้ว</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
