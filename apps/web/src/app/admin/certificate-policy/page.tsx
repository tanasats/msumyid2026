import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { History } from 'lucide-react';
import { CertificateModeSection } from '@/components/certificates/CertificateModeSection';
import { CertificatePolicyForm } from '@/components/certificates/CertificatePolicyForm';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCertificatePolicyForAdmin } from '@/lib/admin-certificate-policy';
import { getRoleAdminOverview } from '@/lib/admin-roles';
import { getCurrentUser } from '@/lib/auth';
import { describePolicyChanges } from '@/lib/certificate-policy';

export const metadata: Metadata = { title: 'นโยบายอายุใบรับรอง' };

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

// นโยบายอายุใบรับรอง (ต้องมี certificate_policy:manage — API ตรวจ ส่วนเว็บซ่อนลิงก์เท่านั้น)
export default async function CertificatePolicyPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('certificate_policy:manage')) redirect('/forbidden');

  // วิธีขอใบของแต่ละบทบาทแก้ได้เฉพาะ super_admin (capabilities.manageRoles) — ผู้มีแค่ certificate_policy:manage ไม่เห็นส่วนนี้
  const [{ policy, logs }, roleOverview] = await Promise.all([
    getCertificatePolicyForAdmin(),
    user.capabilities.manageRoles ? getRoleAdminOverview() : Promise.resolve(null),
  ]);
  const backHref = user.permissions.includes('certificate:read') ? '/admin/certificates' : '/';

  return (
    <PageShell title="นโยบายอายุใบรับรอง" backHref={backHref} user={user} width="form">
      <div className="space-y-6">
        {roleOverview && <CertificateModeSection roles={roleOverview.roles} />}

        <CertificatePolicyForm initial={policy} />

        <section aria-labelledby="policy-history" className="rounded-xl border border-line bg-surface shadow-card">
          <h2 id="policy-history" className="px-5 pt-5 font-display text-lg font-semibold sm:px-6 sm:pt-6">
            ประวัติการแก้ไข
          </h2>
          {logs.length === 0 ? (
            <StatusState icon={History} title="ยังไม่มีการแก้ไข">
              ระบบใช้ค่าเริ่มต้น: ใบประจำตัวอายุ 365 วัน ต่ออายุได้เมื่อเหลือ 30 วัน
            </StatusState>
          ) : (
            <ol className="mt-3 divide-y divide-line">
              {logs.map((log) => (
                <li key={log.id} className="px-5 py-4 sm:px-6">
                  <p className="text-sm">
                    <span className="font-medium">{log.actor?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'}</span>
                    <span className="text-muted"> · {dateTimeFormatter.format(new Date(log.createdAt))}</span>
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm text-muted">
                    {describePolicyChanges(log).map((change) => (
                      <li key={change}>{change}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </PageShell>
  );
}
