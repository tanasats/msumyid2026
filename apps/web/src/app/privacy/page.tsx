import type { Metadata } from 'next';
import { AcknowledgeForm } from '@/components/privacy/AcknowledgeForm';
import { PrivacyNotice } from '@/components/privacy/PrivacyNotice';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'ประกาศความเป็นส่วนตัว' };

/**
 * ประกาศความเป็นส่วนตัว — หน้าสาธารณะ (อ่านได้ก่อน login)
 * login แล้วแต่ยังไม่รับทราบฉบับปัจจุบัน (ทุกหน้าส่งมาที่นี่ด้วย redirectUnlessReady) → แสดงปุ่มรับทราบท้ายประกาศ และยังไม่แสดงเมนู
 */
export default async function PrivacyPage() {
  const user = await getCurrentUser();
  const mustAcknowledge = user !== null && !user.privacyAcknowledged;

  return (
    <PageShell title="ประกาศความเป็นส่วนตัว" width="form" user={mustAcknowledge ? undefined : (user ?? undefined)}>
      <div className="space-y-8">
        {mustAcknowledge && (
          <p className="rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed">
            กรุณาอ่านประกาศความเป็นส่วนตัวของระบบ แล้วกด &ldquo;รับทราบ&rdquo; ท้ายหน้าเพื่อเริ่มใช้งาน
          </p>
        )}
        <PrivacyNotice />
        {mustAcknowledge && <AcknowledgeForm />}
      </div>
    </PageShell>
  );
}
