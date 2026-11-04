import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { Card } from '@/components/Card';
import { LogoutButton } from '@/components/LogoutButton';
import { MfaSetupWizard } from '@/components/mfa/MfaSetupWizard';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser, isMfaPending } from '@/lib/auth';

export const metadata: Metadata = { title: 'ตั้งค่าการยืนยันตัวตนสองขั้นตอน' };

/**
 * ตั้งค่า MFA (ต้อง login และรับทราบประกาศความเป็นส่วนตัวแล้ว)
 * บทบาทบังคับแต่ยังไม่ตั้งค่า: ทุกหน้าส่งมาที่นี่ (redirectUnlessReady) และยังไม่แสดงเมนู
 */
export default async function MfaSetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (isMfaPending(user)) redirect('/mfa');
  if (!user.privacyAcknowledged) redirect('/privacy');
  if (user.mfa.enabled) redirect('/account#security');

  const enforced = user.mfa.required;

  return (
    <PageShell
      title="ตั้งค่าการยืนยันตัวตนสองขั้นตอน"
      width="form"
      backHref={enforced ? undefined : '/account#security'}
      user={enforced ? undefined : user}
    >
      <div className="space-y-6">
        {enforced && (
          <Alert tone="info" title="บทบาทของคุณต้องใช้การยืนยันตัวตนสองขั้นตอน">
            ตั้งค่าให้เสร็จก่อนจึงจะใช้งานระบบได้ ใช้เวลาประมาณ 2 นาที
          </Alert>
        )}
        <Card>
          <MfaSetupWizard email={user.email} doneHref={enforced ? '/' : '/account#security'} />
        </Card>
        {enforced && (
          <div className="sm:w-56">
            <LogoutButton />
          </div>
        )}
      </div>
    </PageShell>
  );
}
