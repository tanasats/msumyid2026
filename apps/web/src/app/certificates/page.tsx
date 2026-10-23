import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Download, FileBadge, FilePlus } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { CertificateStatusBadge } from '@/components/certificates/CertificateStatusBadge';
import { RevokeCertificateButton } from '@/components/certificates/RevokeCertificateButton';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { getCurrentUser } from '@/lib/auth';
import { canRedownload, isKeyCompromised } from '@/lib/certificate';
import { getMyCertificates } from '@/lib/certificates';

export const metadata: Metadata = { title: 'ใบรับรองของฉัน' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

// ใบรับรองของผู้ใช้ปัจจุบัน (ต้อง login เท่านั้น — ดูใบของตัวเองได้เสมอ)
// ปุ่มขอใบใหม่/เพิกถอนแสดงเมื่อมี certificate:request (ซ่อนเพื่อ UX เท่านั้น API ตรวจสิทธิ์อีกครั้ง)
export default async function CertificatesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  const { certificates, primaryRequest } = await getMyCertificates();
  const canRequest = user.permissions.includes('certificate:request');
  // มีใบหลักที่ใช้งานอยู่และยังไม่ถึงช่วงต่ออายุ
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
        {!canRequest && (
          <Alert tone="info" title="ยังขอใบรับรองใหม่ไม่ได้">
            บัญชีของคุณยังไม่ได้รับสิทธิ์ขอใบรับรอง หากต้องการใช้งาน กรุณาติดต่อผู้ดูแลระบบ
          </Alert>
        )}
        {canRequest && renewableFrom && (
          <Alert tone="info" title="คุณมีใบรับรองหลักที่ใช้งานอยู่แล้ว">
            ขอใบใหม่เพื่อต่ออายุได้ตั้งแต่วันที่ {dateFormatter.format(renewableFrom)} (ก่อนใบเดิมหมดอายุ{' '}
            {primaryRequest.renewalWindowDays} วัน) ใบเดิมใช้ได้ต่อจนหมดอายุ
          </Alert>
        )}
        {canRequest && !renewableFrom && certificates.length > 0 && <div className="flex justify-end">{requestButton}</div>}

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
                {canRequest && c.status === 'active' && (
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
                {/* ใบที่ใช้ไม่ได้แล้ว: ปุ่มรองไว้เปิดอีเมลเก่าเท่านั้น (ลงนามใหม่ไม่ได้) */}
                {canRequest && c.status !== 'active' && canRedownload(c) && (
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
      </div>
    </PageShell>
  );
}
