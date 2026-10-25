import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { PageShell } from '@/components/PageShell';
import { ChangeSigningPin } from '@/components/signing/ChangeSigningPin';
import { getCurrentUser } from '@/lib/auth';
import { getSigningPinStatus } from '@/lib/signing-batches';

export const metadata: Metadata = { title: 'เปลี่ยน PIN ลงนาม' };

const timeFormatter = new Intl.DateTimeFormat('th-TH', { timeStyle: 'short', timeZone: 'Asia/Bangkok' });

// ตั้ง/เปลี่ยน PIN ลงนาม (document:sign — API ตรวจ PIN เดิมหรือการเข้าสู่ระบบภายใน 10 นาทีอีกครั้ง)
export default async function SigningPinPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('document:sign')) redirect('/forbidden');

  const status = await getSigningPinStatus();

  return (
    <PageShell title={status.hasPin ? 'เปลี่ยน PIN ลงนาม' : 'ตั้ง PIN ลงนาม'} backHref="/sign" user={user} width="form">
      <div className="space-y-4">
        {status.lockedUntil && (
          <Alert tone="warning" title="PIN ถูกล็อกชั่วคราว">
            ใส่ PIN ผิดหลายครั้ง ใช้ PIN เดิมได้อีกครั้งหลัง {timeFormatter.format(new Date(status.lockedUntil))} น. หรือเข้าสู่ระบบใหม่แล้วตั้ง PIN ใหม่
          </Alert>
        )}
        <ChangeSigningPin hasPin={status.hasPin} />
      </div>
    </PageShell>
  );
}
