import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FilePen } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { P12PasswordForm } from '@/components/certificates/P12PasswordForm';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';
import { SUPPLEMENTARY_STATUS_LABELS, formatRange } from '@/lib/supplementary-certificate';
import { getMySupplementaryRequests } from '@/lib/supplementary-certificates';

export const metadata: Metadata = { title: 'รับใบรับรองเสริม' };

// รับใบรับรองเสริมจากคำขอที่อนุมัติแล้ว: ตั้งรหัส .p12 แล้วระบบออกใบ (ต้องมี supplementary_certificate:request — API ตรวจอีกครั้ง)
export default async function ClaimSupplementaryCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('supplementary_certificate:request')) redirect('/forbidden');

  const { id } = await params;
  const { requests } = await getMySupplementaryRequests();
  const request = requests.find((r) => r.id === id);
  if (!request) notFound();

  const back = (
    <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
      กลับไปที่ใบรับรองของฉัน
    </Link>
  );

  return (
    <PageShell title="รับใบรับรองเสริม" backHref="/certificates" user={user} width="form">
      {request.status !== 'approved' || !request.approvedStart || !request.approvedEnd ? (
        <StatusState icon={FilePen} title={`คำขอนี้${SUPPLEMENTARY_STATUS_LABELS[request.status]}`} action={back}>
          {request.status === 'issued'
            ? 'ใบรับรองอยู่ในรายการใบรับรองของคุณ ดาวน์โหลดไฟล์ใหม่ได้จากที่นั่น'
            : 'รับใบรับรองได้เฉพาะคำขอที่อนุมัติแล้วและยังไม่เลยวันสิ้นสุด'}
        </StatusState>
      ) : (
        <P12PasswordForm
          endpoint={`/me/supplementary-certificate-requests/${request.id}/certificate`}
          submitLabel="รับใบรับรอง"
          successTitle="ออกใบรับรองเสริมเรียบร้อยแล้ว"
        >
          <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
            <h2 className="font-display text-lg font-semibold">ข้อมูลในใบรับรอง</h2>
            <InfoList className="mt-4">
              <InfoRow label="ชื่อ">{user.name}</InfoRow>
              <InfoRow label="อีเมล">
                <span className="break-all">{user.email}</span>
              </InfoRow>
              <InfoRow label="ใช้ได้">
                <span className="tabular-nums">{formatRange(request.approvedStart, request.approvedEnd)}</span>
              </InfoRow>
              <InfoRow label="วัตถุประสงค์">
                <span className="break-words">{request.purpose}</span>
              </InfoRow>
            </InfoList>
          </section>
          <Alert tone="info" title="ใช้ลงนามเอกสารเท่านั้น">
            ใบรับรองเสริมใช้กับอีเมลไม่ได้ และหมดอายุเมื่อสิ้นวันสุดท้าย ควรตั้ง Timestamp Server ในโปรแกรมที่ใช้ลงนาม
            ลายมือชื่อจึงยังตรวจสอบได้หลังใบหมดอายุ (ดูวิธีตั้งที่หน้า{' '}
            <Link href="/root-ca" className="font-medium underline">
              ติดตั้งใบรับรองหลัก
            </Link>
            )
          </Alert>
        </P12PasswordForm>
      )}
    </PageShell>
  );
}
