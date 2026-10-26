import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FileBadge } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { P12PasswordForm } from '@/components/certificates/P12PasswordForm';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { getMyCertificates } from '@/lib/certificates';
import { getMyPrimaryRequests } from '@/lib/primary-certificate-requests';
import { SUPPLEMENTARY_STATUS_LABELS } from '@/lib/supplementary-certificate';

export const metadata: Metadata = { title: 'รับใบรับรองประจำตัว' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });

// รับใบรับรองประจำตัวจากคำขอที่อนุมัติแล้ว: ตั้งรหัส .p12 แล้วระบบออกใบ (ต้องมี certificate:apply — API ตรวจอีกครั้ง)
export default async function ClaimPrimaryCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);
  if (!user.permissions.includes('certificate:apply')) redirect('/forbidden');

  const { id } = await params;
  const [requests, { primaryRequest }] = await Promise.all([getMyPrimaryRequests(), getMyCertificates()]);
  const request = requests.find((r) => r.id === id);
  if (!request) notFound();

  const back = (
    <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
      กลับไปที่ใบรับรองของฉัน
    </Link>
  );

  return (
    <PageShell title="รับใบรับรองประจำตัว" backHref="/certificates" user={user} width="form">
      {request.status !== 'approved' ? (
        <StatusState icon={FileBadge} title={`คำขอนี้${SUPPLEMENTARY_STATUS_LABELS[request.status]}`} action={back}>
          {request.status === 'issued'
            ? 'ใบรับรองอยู่ในรายการใบรับรองของคุณ ดาวน์โหลดไฟล์ใหม่ได้จากที่นั่น'
            : 'รับใบรับรองได้เฉพาะคำขอที่อนุมัติแล้ว ภายใน 30 วันหลังอนุมัติ'}
        </StatusState>
      ) : (
        <P12PasswordForm
          endpoint={`/me/primary-certificate-requests/${request.id}/certificate`}
          submitLabel="รับใบรับรอง"
          successTitle="ออกใบรับรองเรียบร้อยแล้ว"
        >
          <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
            <h2 className="font-display text-lg font-semibold">ข้อมูลในใบรับรอง</h2>
            <p className="mt-1 text-sm text-muted">มาจากบัญชีของคุณ หากไม่ถูกต้องกรุณาติดต่อผู้ดูแลระบบก่อนรับใบรับรอง</p>
            <InfoList className="mt-4">
              <InfoRow label="ชื่อ">{user.name}</InfoRow>
              <InfoRow label="อีเมล">
                <span className="break-all">{user.email}</span>
              </InfoRow>
              <InfoRow label="หมดอายุ">{dateFormatter.format(new Date(primaryRequest.expiresAtIfRequested))}</InfoRow>
              {request.claimableUntil && (
                <InfoRow label="รับใบได้ถึง">{dateFormatter.format(new Date(request.claimableUntil))}</InfoRow>
              )}
            </InfoList>
          </section>
        </P12PasswordForm>
      )}
    </PageShell>
  );
}
