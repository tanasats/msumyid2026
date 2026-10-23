import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileBadge } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { RequestCertificateForm } from '@/components/certificates/RequestCertificateForm';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';
import { getMyCertificates } from '@/lib/certificates';

export const metadata: Metadata = { title: 'ขอใบรับรองใหม่' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });

// ขอใบรับรองประจำตัว (ต้องมี certificate:request — API ตรวจสิทธิ์และกฎใบประจำตัว 1 ใบ/ช่วงต่ออายุอีกครั้งตอนส่ง)
export default async function NewCertificatePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('certificate:request')) redirect('/forbidden');

  const { primaryRequest } = await getMyCertificates();
  const renewableFrom = primaryRequest.renewableFrom ? new Date(primaryRequest.renewableFrom) : null;

  return (
    <PageShell title="ขอใบรับรองใหม่" backHref="/certificates" user={user} width="form">
      {renewableFrom ? (
        <StatusState
          icon={FileBadge}
          title="คุณมีใบรับรองประจำตัวที่ใช้งานอยู่แล้ว"
          action={
            <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
              กลับไปที่ใบรับรองของฉัน
            </Link>
          }
        >
          ขอใบใหม่เพื่อต่ออายุได้ตั้งแต่วันที่ {dateFormatter.format(renewableFrom)}
        </StatusState>
      ) : (
        <RequestCertificateForm
          name={user.name}
          email={user.email}
          expiresAt={dateFormatter.format(new Date(primaryRequest.expiresAtIfRequested))}
        />
      )}
    </PageShell>
  );
}
