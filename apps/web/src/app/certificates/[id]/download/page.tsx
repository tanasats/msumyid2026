import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { CertificateStatusBadge } from '@/components/certificates/CertificateStatusBadge';
import { P12PasswordForm } from '@/components/certificates/P12PasswordForm';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';
import { isKeyCompromised } from '@/lib/certificate';
import { getMyCertificates } from '@/lib/certificates';

export const metadata: Metadata = { title: 'ดาวน์โหลดไฟล์ใบรับรองใหม่' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' });

// ดาวน์โหลด .p12 ใหม่จาก key สำรอง ด้วยรหัสผ่านใหม่ (ต้องมี certificate:request — API ตรวจเจ้าของใบอีกครั้งตอนส่ง)
export default async function DownloadCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('certificate:request')) redirect('/forbidden');

  const { id } = await params;
  const { certificates } = await getMyCertificates();
  const certificate = certificates.find((c) => c.id === id);
  if (!certificate) notFound();

  return (
    <PageShell title="ดาวน์โหลดไฟล์ใบรับรองใหม่" backHref="/certificates" user={user} width="form">
      {isKeyCompromised(certificate) ? (
        <StatusState
          icon={ShieldAlert}
          title="ใบรับรองนี้ถูกเพิกถอนเพราะ key อาจหลุดไปถึงผู้อื่น"
          action={
            <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
              กลับไปที่ใบรับรองของฉัน
            </Link>
          }
        >
          ระบบจึงไม่สร้างไฟล์ที่มี key นี้ออกไปอีก
        </StatusState>
      ) : !certificate.hasKeyEscrow ? (
        <StatusState
          icon={KeyRound}
          title="ใบรับรองนี้ไม่มี key สำรองในระบบ"
          action={
            <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
              กลับไปที่ใบรับรองของฉัน
            </Link>
          }
        >
          จึงสร้างไฟล์ใหม่ให้ไม่ได้ ถ้าไม่มีไฟล์เดิมแล้ว ให้ขอใบรับรองใหม่
        </StatusState>
      ) : (
        <P12PasswordForm
          endpoint={`/me/certificates/${certificate.id}/p12`}
          submitLabel={certificate.status === 'active' ? 'ดาวน์โหลดไฟล์' : 'ดาวน์โหลดไว้เปิดอีเมลเก่า'}
          successTitle="สร้างไฟล์ใบรับรองใหม่แล้ว"
        >
          <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-display text-lg font-semibold">ใบรับรองเดิม</h2>
              <CertificateStatusBadge status={certificate.status} />
            </div>
            <p className="mt-1 text-sm text-muted">
              ใช้เมื่อลืมรหัสผ่านไฟล์ ทำไฟล์หาย หรือติดตั้งในเครื่องใหม่ — ได้ใบรับรองและ key ชุดเดิม ไม่ใช่ใบใหม่
            </p>
            <InfoList className="mt-4">
              <InfoRow label="ชื่อ">{certificate.subjectCn}</InfoRow>
              <InfoRow label="อีเมล">
                <span className="break-all">{certificate.email}</span>
              </InfoRow>
              <InfoRow label="ใช้ได้ถึง">
                <span className="tabular-nums">{dateFormatter.format(new Date(certificate.notAfter))}</span>
              </InfoRow>
              <InfoRow label="หมายเลข">
                <span className="font-mono text-xs break-all">{certificate.serialNumber}</span>
              </InfoRow>
            </InfoList>
          </section>
          {certificate.status !== 'active' && (
            <Alert tone="warning" title={certificate.status === 'revoked' ? 'ใบรับรองนี้ถูกเพิกถอนแล้ว' : 'ใบรับรองนี้หมดอายุแล้ว'}>
              ใช้ลงนามใหม่ไม่ได้ ไฟล์นี้มีไว้เปิดอีเมลเก่าที่เคยถูกเข้ารหัสถึงคุณเท่านั้น
            </Alert>
          )}
        </P12PasswordForm>
      )}
    </PageShell>
  );
}
