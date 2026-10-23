import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FilePen } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { SupplementaryRequestForm } from '@/components/certificates/SupplementaryRequestForm';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';
import { getMySupplementaryRequests } from '@/lib/supplementary-certificates';

export const metadata: Metadata = { title: 'ขอใบรับรองเสริม' };

// ส่งคำขอใบรับรองเสริม (ต้องมี supplementary_certificate:request — API ตรวจสิทธิ์ ช่วงวันที่ และเพดานอีกครั้งตอนส่ง)
export default async function NewSupplementaryRequestPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('supplementary_certificate:request')) redirect('/forbidden');

  const { limits } = await getMySupplementaryRequests();
  const full = limits.open >= limits.maxActive;

  return (
    <PageShell title="ขอใบรับรองเสริม" backHref="/certificates" user={user} width="form">
      {full ? (
        <StatusState
          icon={FilePen}
          title={limits.maxActive === 0 ? 'ยังไม่เปิดให้ขอใบรับรองเสริม' : 'ขอใบรับรองเสริมเพิ่มไม่ได้ในตอนนี้'}
          action={
            <Link href="/certificates" className={buttonClasses({ fullWidth: true })}>
              กลับไปที่ใบรับรองของฉัน
            </Link>
          }
        >
          {limits.maxActive === 0
            ? 'กรุณาติดต่อผู้ดูแลระบบ'
            : `มีใบรับรองเสริมที่ใช้งานอยู่และคำขอที่ค้างครบ ${limits.maxActive} รายการแล้ว`}
        </StatusState>
      ) : (
        <SupplementaryRequestForm name={user.name} email={user.email} limits={limits} />
      )}
    </PageShell>
  );
}
