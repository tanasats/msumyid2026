import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, FileBadge, FilePen, FilePlus } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { CertificateStatusBadge } from '@/components/certificates/CertificateStatusBadge';
import { PrimaryRequestCard } from '@/components/certificates/PrimaryRequestCard';
import { RevokeCertificateButton } from '@/components/certificates/RevokeCertificateButton';
import { SubmitPrimaryRequestButton } from '@/components/certificates/SubmitPrimaryRequestButton';
import { SupplementaryRequestCard } from '@/components/certificates/SupplementaryRequestCard';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { getCurrentUser } from '@/lib/auth';
import { canRedownload, isKeyCompromised, type Certificate } from '@/lib/certificate';
import { getMyCertificates } from '@/lib/certificates';
import { getMyPrimaryRequests } from '@/lib/primary-certificate-requests';
import { getMySupplementaryRequests } from '@/lib/supplementary-certificates';

export const metadata: Metadata = { title: 'ใบรับรองของฉัน' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

// ใบรับรองของผู้ใช้ปัจจุบัน (ต้อง login เท่านั้น — ดูใบและคำขอของตัวเองได้เสมอ)
// ปุ่มขอ/เพิกถอน/ดาวน์โหลดแสดงตามสิทธิ์ของประเภทใบ (ซ่อนเพื่อ UX เท่านั้น API ตรวจสิทธิ์อีกครั้ง):
// ใบประจำตัว = certificate:request (สร้างเองได้) หรือ certificate:apply (ส่งคำขอรออนุมัติ), ใบเสริม = supplementary_certificate:request
export default async function CertificatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  const [{ certificates, primaryRequest }, supplementary, primaryRequests, params] = await Promise.all([
    getMyCertificates(),
    getMySupplementaryRequests(),
    getMyPrimaryRequests(),
    searchParams,
  ]);
  const canRequest = user.permissions.includes('certificate:request');
  // ส่งคำขอได้เฉพาะเมื่อสร้างเองไม่ได้ (มีทั้งสองสิทธิ์ = สร้างเองได้)
  const canApply = !canRequest && user.permissions.includes('certificate:apply');
  const canRequestSupplementary = user.permissions.includes('supplementary_certificate:request');
  const canManage = (c: Pick<Certificate, 'kind'>) =>
    c.kind === 'supplementary' ? canRequestSupplementary : canRequest || user.permissions.includes('certificate:apply');
  const hasOpenPrimaryRequest = primaryRequests.some((r) => r.status === 'pending' || r.status === 'approved');
  const { limits } = supplementary;
  const supplementaryFull = limits.open >= limits.maxActive;
  // มีใบประจำตัวที่ใช้งานอยู่และยังไม่ถึงช่วงต่ออายุ
  const renewableFrom = primaryRequest.renewableFrom ? new Date(primaryRequest.renewableFrom) : null;

  const requestButton = (
    <Link href="/certificates/new" className={buttonClasses({ fullWidth: true })}>
      <FilePlus className="size-5" aria-hidden />
      {renewableFrom === null && certificates.some((c) => c.kind === 'primary' && c.status === 'active')
        ? 'ต่ออายุใบรับรอง'
        : 'ขอใบรับรองใหม่'}
    </Link>
  );

  return (
    <PageShell title="ใบรับรองของฉัน" user={user}>
      <div className="space-y-4">
        {!canRequest && !canApply && (
          <Alert tone="info" title="ยังขอใบรับรองใหม่ไม่ได้">
            บัญชีของคุณยังไม่ได้รับสิทธิ์ขอใบรับรอง หากต้องการใช้งาน กรุณาติดต่อผู้ดูแลระบบ
          </Alert>
        )}
        {(canRequest || canApply) && renewableFrom && (
          <Alert tone="info" title="คุณมีใบรับรองประจำตัวที่ใช้งานอยู่แล้ว">
            ขอใบใหม่เพื่อต่ออายุได้ตั้งแต่วันที่ {dateFormatter.format(renewableFrom)} (ก่อนใบเดิมหมดอายุ{' '}
            {primaryRequest.renewalWindowDays} วัน) ใบเดิมใช้ได้ต่อจนหมดอายุ
          </Alert>
        )}
        {canRequest && !renewableFrom && certificates.length > 0 && <div className="flex justify-end">{requestButton}</div>}
        {params.applied === '1' && (
          <Alert tone="success" title="ส่งคำขอแล้ว">
            เมื่อได้รับอนุมัติ กด &quot;รับใบรับรอง&quot; ที่คำขอภายใน 30 วันเพื่อตั้งรหัสผ่านและดาวน์โหลดไฟล์
          </Alert>
        )}
        {(canApply || primaryRequests.length > 0) && (
          <section aria-labelledby="primary-requests-heading" className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="primary-requests-heading" className="font-display text-lg font-semibold">
                  คำขอใบรับรองประจำตัว
                </h2>
                <p className="mt-1 text-sm text-muted">ส่งคำขอแล้วรอผู้ดูแลอนุมัติ จากนั้นกดรับใบรับรองเอง</p>
              </div>
              {canApply && !renewableFrom && !hasOpenPrimaryRequest && (
                <div className="shrink-0">
                  <SubmitPrimaryRequestButton name={user.name} email={user.email} />
                </div>
              )}
            </div>
            {primaryRequests.length > 0 && (
              <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
                {primaryRequests.map((r) => (
                  <PrimaryRequestCard key={r.id} request={r} canAct={canApply} />
                ))}
              </ul>
            )}
          </section>
        )}

        {certificates.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface shadow-card">
            <StatusState
              icon={FileBadge}
              title="ยังไม่มีใบรับรอง"
              action={canRequest ? requestButton : undefined}
            >
              ใบรับรองใช้ลงนามและเข้ารหัสอีเมล และลงนามเอกสารด้วยชื่อของคุณ
            </StatusState>
          </div>
        ) : (
          // จอใหญ่: 2 คอลัมน์ ไม่ให้การ์ดยืดเต็มความกว้าง 6xl
          <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
            {certificates.map((c) => (
              <li key={c.id} className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold break-words">{c.subjectCn}</p>
                    <p className="text-sm break-all text-muted">{c.email}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {c.kind === 'supplementary' && <Tag>ใบรับรองเสริม</Tag>}
                    {c.source === 'imported' && <Tag>นำเข้าจากระบบเดิม</Tag>}
                    <CertificateStatusBadge status={c.status} />
                  </div>
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted">ใช้ได้ตั้งแต่</dt>
                  <dd className="tabular-nums">
                    {dateFormatter.format(new Date(c.notBefore))} – {dateFormatter.format(new Date(c.notAfter))}
                  </dd>
                  {c.revokedAt && (
                    <>
                      <dt className="text-muted">เพิกถอนเมื่อ</dt>
                      <dd className="tabular-nums">{dateFormatter.format(new Date(c.revokedAt))}</dd>
                    </>
                  )}
                  <dt className="text-muted">หมายเลขใบรับรอง</dt>
                  <dd className="font-mono text-xs break-all">{c.serialNumber}</dd>
                </dl>
                {canManage(c) && c.status === 'active' && (
                  <div className="mt-4 flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:justify-end">
                    <RevokeCertificateButton endpoint={`/me/certificates/${c.id}/revoke`} serialNumber={c.serialNumber} />
                    {canRedownload(c) && (
                      <Link
                        href={`/certificates/${c.id}/download`}
                        className={buttonClasses({ variant: 'secondary', size: 'sm', fullWidth: true })}
                      >
                        <Download className="size-4" aria-hidden />
                        ดาวน์โหลดไฟล์ใหม่
                      </Link>
                    )}
                  </div>
                )}
                {/* ใบประจำตัวที่ใช้ไม่ได้แล้ว: ปุ่มรองไว้เปิดอีเมลเก่าเท่านั้น (ลงนามใหม่ไม่ได้) — ใบเสริมไม่ใช้กับอีเมล จึงไม่มีปุ่มนี้ */}
                {c.kind === 'primary' && canManage(c) && c.status !== 'active' && canRedownload(c) && (
                  <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-muted">ใช้ลงนามไม่ได้แล้ว ดาวน์โหลดได้เพื่อเปิดอีเมลเก่าที่เข้ารหัสไว้</p>
                    <Link
                      href={`/certificates/${c.id}/download`}
                      className={buttonClasses({ variant: 'ghost', size: 'sm', fullWidth: true })}
                    >
                      <Download className="size-4" aria-hidden />
                      ดาวน์โหลดไว้เปิดอีเมลเก่า
                    </Link>
                  </div>
                )}
                {isKeyCompromised(c) && (
                  <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
                    เพิกถอนเพราะ key อาจหลุดไปถึงผู้อื่น จึงดาวน์โหลดไฟล์ใหม่ไม่ได้
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {(canRequestSupplementary || supplementary.requests.length > 0) && (
          <section aria-labelledby="supplementary-heading" className="space-y-3 pt-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 id="supplementary-heading" className="font-display text-lg font-semibold">
                  ใบรับรองเสริม
                </h2>
                <p className="mt-1 text-sm text-muted">
                  ใบเฉพาะกิจสำหรับลงนามเอกสารในช่วงวันที่กำหนด ส่งคำขอแล้วรอผู้ดูแลอนุมัติ ใช้กับอีเมลไม่ได้
                </p>
              </div>
              {canRequestSupplementary && !supplementaryFull && (
                <Link
                  href="/certificates/supplementary/new"
                  className={`${buttonClasses({ variant: 'secondary', fullWidth: true })} shrink-0`}
                >
                  <FilePen className="size-5" aria-hidden />
                  ขอใบรับรองเสริม
                </Link>
              )}
            </div>
            {params.requested === '1' && (
              <Alert tone="success" title="ส่งคำขอแล้ว">
                เมื่อได้รับอนุมัติ กด &quot;รับใบรับรอง&quot; ที่คำขอเพื่อตั้งรหัสผ่านและดาวน์โหลดไฟล์
              </Alert>
            )}
            {canRequestSupplementary && supplementaryFull && (
              <Alert tone="info">
                {limits.maxActive === 0
                  ? 'ขณะนี้ยังไม่เปิดให้ขอใบรับรองเสริม'
                  : `มีใบรับรองเสริมที่ใช้งานอยู่และคำขอที่ค้างครบ ${limits.maxActive} รายการแล้ว ขอเพิ่มได้เมื่อใบเดิมหมดอายุหรือยกเลิกคำขอ`}
              </Alert>
            )}
            {supplementary.requests.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface shadow-card">
                <StatusState icon={FilePen} title="ยังไม่มีคำขอใบรับรองเสริม">
                  ใช้เมื่อต้องลงนามเอกสารเฉพาะกิจ เช่น เกียรติบัตรของงาน โดยไม่ใช้ใบรับรองประจำตัว
                </StatusState>
              </div>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
                {supplementary.requests.map((r) => (
                  <SupplementaryRequestCard key={r.id} request={r} canAct={canRequestSupplementary} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </PageShell>
  );
}
