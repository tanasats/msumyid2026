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

// ขอใบรับรองใหม่ (ต้องมี certificate:request — API ตรวจสิทธิ์และจำนวนใบอีกครั้งตอนส่ง)
export default async function NewCertificatePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('certificate:request')) redirect('/forbidden');

  const { certificates, maxActive } = await getMyCertificates();
  const atLimit = certificates.filter((c) => c.status === 'active').length >= maxActive;

  return (
    <PageShell title="ขอใบรับรองใหม่" backHref="/certificates" user={user} width="form">
      {atLimit ? (
        <StatusState
          icon={FileBadge}
          title={`มีใบรับรองที่ใช้งานอยู่ครบ ${maxActive} ใบแล้ว`}
          action={
            <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
              กลับไปที่ใบรับรองของฉัน
            </Link>
          }
        >
          ขอใบใหม่ได้เมื่อใบเดิมหมดอายุหรือถูกเพิกถอน
        </StatusState>
      ) : (
        <RequestCertificateForm name={user.name} email={user.email} />
      )}
    </PageShell>
  );
}
