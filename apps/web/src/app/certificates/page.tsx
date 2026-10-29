import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronDown, Download, FileBadge, FilePen, FilePlus, History } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { CertificateStatusBadge } from '@/components/certificates/CertificateStatusBadge';
import { CancelSupplementaryRequestButton } from '@/components/certificates/CancelSupplementaryRequestButton';
import { PrimaryRequestCard } from '@/components/certificates/PrimaryRequestCard';
import { RevokeCertificateButton } from '@/components/certificates/RevokeCertificateButton';
import { SubmitPrimaryRequestButton } from '@/components/certificates/SubmitPrimaryRequestButton';
import { SupplementaryRequestCard } from '@/components/certificates/SupplementaryRequestCard';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { Tag } from '@/components/UserStatusBadge';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { SELF_REVOCATION_REASONS, canRedownload, isKeyCompromised, type Certificate } from '@/lib/certificate';
import { URGENT_REVOCATION_REASONS } from '@/lib/certificate-revocation-request';
import { getMyRevocationRequests } from '@/lib/certificate-revocation-requests';
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
  redirectUnlessReady(user);

  const [{ certificates, primaryRequest }, supplementary, primaryRequests, revocation, params] = await Promise.all([
    getMyCertificates(),
    getMySupplementaryRequests(),
    getMyPrimaryRequests(),
    getMyRevocationRequests(),
    searchParams,
  ]);
  const hasRequestPermission = user.permissions.includes('certificate:request');
  // เพิกถอนใบประจำตัวเองเกินโควตาในรอบ 1 ปี: สร้างเองไม่ได้ ต้องส่งคำขอแทน (API ตรวจอีกครั้ง)
  const mustApply = hasRequestPermission && primaryRequest.reissueLimitReached;
  const canRequest = hasRequestPermission && !mustApply;
  // ส่งคำขอได้เฉพาะเมื่อสร้างเองไม่ได้ (มีทั้งสองสิทธิ์ = สร้างเองได้)
  const canApply = (!hasRequestPermission && user.permissions.includes('certificate:apply')) || mustApply;
  const canRequestSupplementary = user.permissions.includes('supplementary_certificate:request');
  const canManage = (c: Pick<Certificate, 'kind'>) =>
    c.kind === 'supplementary'
      ? canRequestSupplementary
      : hasRequestPermission || user.permissions.includes('certificate:apply');
  const hasOpenPrimaryRequest = primaryRequests.some((r) => r.status === 'pending' || r.status === 'approved');
  const { limits } = supplementary;
  const supplementaryFull = limits.open >= limits.maxActive;
  // มีใบประจำตัวที่ใช้งานอยู่และยังไม่ถึงช่วงต่ออายุ
  const renewableFrom = primaryRequest.renewableFrom ? new Date(primaryRequest.renewableFrom) : null;

  // ใบเสริมที่หมดอายุ/ถูกเพิกถอนใช้ลงนามไม่ได้แล้ว และไม่ต้องดาวน์โหลด (ใช้ลงนามเอกสารอย่างเดียว ไม่มีอีเมลเข้ารหัสให้เปิด)
  // → ย้ายไปประวัติ (ฐานข้อมูลเก็บไว้ทั้งหมด) ส่วนใบประจำตัวคงในรายการหลักทุกสถานะ เพราะต้องดาวน์โหลดเปิดอีเมลเก่าได้
  const isSupplementaryHistory = (c: Certificate) => c.kind === 'supplementary' && c.status !== 'active';
  const mainCertificates = certificates.filter((c) => !isSupplementaryHistory(c));
  const supplementaryHistory = certificates.filter(isSupplementaryHistory);
  // คำขอที่ยังต้องทำอะไรต่อ (รออนุมัติ / รอกดรับใบ) แสดงตามปกติ ที่จบแล้ว (ได้รับใบ/ไม่อนุมัติ/ยกเลิก/หมดเวลา) ย้ายไปประวัติ
  const isOpenRequest = (status: string) => status === 'pending' || status === 'approved';
  const openRequests = supplementary.requests.filter((r) => isOpenRequest(r.status));
  const finishedRequests = supplementary.requests.filter((r) => !isOpenRequest(r.status));
  const historyCount = supplementaryHistory.length + finishedRequests.length;

  // คำขอเพิกถอนล่าสุดของแต่ละใบ (API เรียงล่าสุดก่อน) — ใบประจำตัวที่เหตุผลไม่เร่งด่วนต้องรออนุมัติ (super_admin เพิกถอนเองได้)
  const latestRevocationRequest = (certificateId: string) =>
    revocation.requests.find((r) => r.certificate.id === certificateId);
  const reasonLabel = (value: string) => SELF_REVOCATION_REASONS.find((r) => r.value === value)?.label ?? value;
  const urgentReasons = SELF_REVOCATION_REASONS.filter((r) => URGENT_REVOCATION_REASONS.includes(r.value));

  const revokeButton = (c: Certificate) => {
    const pending = latestRevocationRequest(c.id)?.status === 'pending';
    const needsRequest = c.kind === 'primary' && !revocation.canRevokeDirectly;
    return (
      <RevokeCertificateButton
        endpoint={`/me/certificates/${c.id}/revoke`}
        serialNumber={c.serialNumber}
        trigger="link"
        // มีคำขอรออยู่แล้ว: เหลือเฉพาะการเพิกถอนด่วน (คำขอเดิมถูกยกเลิกอัตโนมัติ)
        reasons={needsRequest && pending ? urgentReasons : undefined}
        requestEndpoint={needsRequest && !pending ? `/me/certificates/${c.id}/revocation-requests` : undefined}
        // ใบประจำตัว: ถามก่อนว่าแค่ลืมรหัสผ่าน/เปลี่ยนเครื่องหรือไม่ (ดาวน์โหลดใหม่ได้ ไม่ต้องเพิกถอน)
        // ใบเสริมใช้ลงนามบนเว็บอย่างเดียว ไม่มีไฟล์ให้ลืมรหัสผ่าน
        downloadHref={
          c.kind === 'primary' ? (canRedownload(c) ? `/certificates/${c.id}/download` : null) : undefined
        }
      />
    );
  };

  // สถานะคำขอเพิกถอนของใบที่ยังใช้งานอยู่: รออนุมัติ (ยกเลิกได้) หรือไม่อนุมัติ (แสดงเหตุผลจากผู้ดูแล)
  const renderRevocationRequest = (c: Certificate) => {
    const r = latestRevocationRequest(c.id);
    if (!r || c.status !== 'active') return null;
    if (r.status === 'pending') {
      return (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            <span className="block font-medium">ส่งคำขอเพิกถอนแล้ว รอผู้ดูแลอนุมัติ</span>
            <span className="block text-muted">เหตุผล: {reasonLabel(r.reason)} — ระหว่างนี้ใบยังใช้งานได้</span>
          </p>
          <div className="shrink-0">
            <CancelSupplementaryRequestButton
              requestId={r.id}
              basePath="/me/certificate-revocation-requests"
              description="ใบรับรองจะใช้งานได้ต่อตามปกติ ถ้ายังต้องการเพิกถอนต้องส่งคำขอใหม่"
            />
          </div>
        </div>
      );
    }
    if (r.status === 'rejected') {
      return (
        <p className="mt-4 border-t border-line pt-4 text-sm">
          <span className="block font-medium">คำขอเพิกถอนไม่ได้รับอนุมัติ</span>
          {r.decisionNote && <span className="block break-words text-muted">เหตุผล: {r.decisionNote}</span>}
        </p>
      );
    }
    return null;
  };

  const renderCertificate = (c: Certificate) => (
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
      {canManage(c) && renderRevocationRequest(c)}
      {canManage(c) && c.status === 'active' && (
        // ดาวน์โหลดเป็นงานหลักของการ์ด การเพิกถอนเป็นลิงก์ข้อความรอง (ไม่อยากให้เพิกถอนโดยไม่จำเป็น)
        // มือถือ: ดาวน์โหลดบน ลิงก์ล่าง / จอใหญ่: ลิงก์ซ้าย ดาวน์โหลดขวา
        <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row-reverse sm:items-center sm:justify-between">
          {canRedownload(c) && (
            <Link
              href={`/certificates/${c.id}/download`}
              className={buttonClasses({ variant: 'secondary', size: 'sm', fullWidth: true })}
            >
              <Download className="size-4" aria-hidden />
              ดาวน์โหลดไฟล์ใหม่
            </Link>
          )}
          {revokeButton(c)}
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
  );

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
        {mustApply && !renewableFrom && (
          <Alert tone="info" title="ขอใบรับรองประจำตัวใหม่ต้องส่งคำขอ">
            คุณเพิกถอนใบรับรองประจำตัวครบจำนวนที่สร้างใบใหม่เองได้ในรอบ 1 ปีแล้ว ส่งคำขอด้านล่างแล้วรอผู้ดูแลอนุมัติ
            (ลืมรหัสผ่านหรือเปลี่ยนเครื่องไม่ต้องเพิกถอน ใช้ &quot;ดาวน์โหลดไฟล์ใหม่&quot; ได้)
          </Alert>
        )}
        {(canRequest || canApply) && renewableFrom && (
          <Alert tone="info" title="คุณมีใบรับรองประจำตัวที่ใช้งานอยู่แล้ว">
            ขอใบใหม่เพื่อต่ออายุได้ตั้งแต่วันที่ {dateFormatter.format(renewableFrom)} (ก่อนใบเดิมหมดอายุ{' '}
            {primaryRequest.renewalWindowDays} วัน) ใบเดิมใช้ได้ต่อจนหมดอายุ
          </Alert>
        )}
        {canRequest && !renewableFrom && mainCertificates.length > 0 && <div className="flex justify-end">{requestButton}</div>}
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
                  // ผู้ที่ส่งคำขอเพราะเกินโควตา (certificate:request) รับใบ/ยกเลิกได้แม้โควตาคืนแล้ว
                  <PrimaryRequestCard key={r.id} request={r} canAct={canApply || hasRequestPermission} />
                ))}
              </ul>
            )}
          </section>
        )}

        {mainCertificates.length === 0 ? (
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
            {mainCertificates.map(renderCertificate)}
          </ul>
        )}

        {(canRequestSupplementary || supplementary.requests.length > 0 || supplementaryHistory.length > 0) && (
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
            {supplementary.requests.length === 0 && supplementaryHistory.length === 0 ? (
              <div className="rounded-xl border border-line bg-surface shadow-card">
                <StatusState icon={FilePen} title="ยังไม่มีคำขอใบรับรองเสริม">
                  ใช้เมื่อต้องลงนามเอกสารเฉพาะกิจ เช่น เกียรติบัตรของงาน โดยไม่ใช้ใบรับรองประจำตัว
                </StatusState>
              </div>
            ) : (
              openRequests.length > 0 && (
                <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
                  {openRequests.map((r) => (
                    <SupplementaryRequestCard key={r.id} request={r} canAct={canRequestSupplementary} />
                  ))}
                </ul>
              )
            )}
            {historyCount > 0 && (
              // ปิดไว้ค่าเริ่มต้น — ดูย้อนหลังได้ ไม่มีปุ่มดำเนินการ (ใบหมดอายุไม่ต้องเพิกถอนหรือดาวน์โหลด)
              <details className="group rounded-xl border border-line bg-surface shadow-card">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 font-medium hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
                  <History className="size-5 shrink-0 text-muted" aria-hidden />
                  <span className="flex-1">ประวัติใบรับรองเสริม ({historyCount})</span>
                  <ChevronDown className="size-5 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <div className="space-y-5 border-t border-line p-4 sm:p-5">
                  {supplementaryHistory.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium text-muted">ใบรับรองที่หมดอายุหรือถูกเพิกถอน</h3>
                      <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">{supplementaryHistory.map(renderCertificate)}</ul>
                    </div>
                  )}
                  {finishedRequests.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium text-muted">คำขอที่จบแล้ว</h3>
                      <ul className="grid gap-3 lg:grid-cols-2 lg:gap-4">
                        {finishedRequests.map((r) => (
                          <SupplementaryRequestCard key={r.id} request={r} canAct={canRequestSupplementary} />
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            )}
          </section>
        )}
      </div>
    </PageShell>
  );
}
