import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { Avatar } from '@/components/Avatar';
import { LogoutButton } from '@/components/LogoutButton';
import { PageShell } from '@/components/PageShell';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';
import { getMyStaffProfile, type StaffProfile } from '@/lib/staff-profile';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

// ข้อมูลบัญชีของผู้ใช้ปัจจุบัน + ข้อมูลบุคลากรจาก ERP-HR + ออกจากระบบ (ต้อง login เท่านั้น ไม่ต้องมี permission)
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  const staffProfile = user.accountType === 'staff' ? await getMyStaffProfile() : null;

  return (
    <PageShell title="บัญชีของฉัน" user={user} width="form">
      <div className="space-y-6">
        <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <Avatar name={user.name} pictureUrl={user.pictureUrl} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{user.name}</h2>
              <p className="text-sm break-all text-muted">{user.email}</p>
            </div>
          </div>

          <dl className="mt-6 divide-y divide-line border-t border-line text-sm">
            <InfoRow label="ประเภทบัญชี">{ACCOUNT_TYPE_LABELS[user.accountType]}</InfoRow>
            <InfoRow label="บทบาท">
              <span className="flex flex-wrap gap-2">
                {user.roles.map((role) => (
                  <span key={role} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                    {role}
                  </span>
                ))}
              </span>
            </InfoRow>
          </dl>
        </section>

        {user.accountType === 'staff' &&
          (staffProfile ? (
            <StaffProfileSection profile={staffProfile} />
          ) : (
            <Alert tone="info" title="ยังไม่มีข้อมูลบุคลากร">
              ระบบยังดึงข้อมูลจากระบบบุคลากร (ERP) ไม่สำเร็จ จะลองใหม่เมื่อคุณเข้าสู่ระบบครั้งถัดไป
            </Alert>
          ))}

        <LogoutButton />
      </div>
    </PageShell>
  );
}

function StaffProfileSection({ profile }: { profile: StaffProfile }) {
  const fullNameTh = [profile.prefixTh, `${profile.firstNameTh} ${profile.lastNameTh}`].filter(Boolean).join('');
  const fullNameEn = [profile.prefixEn, profile.firstNameEn, profile.lastNameEn].filter(Boolean).join(' ');

  return (
    <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">ข้อมูลบุคลากร</h2>
      <p className="mt-1 text-sm text-muted">ข้อมูลจากระบบบุคลากร (ERP) ของมหาวิทยาลัย อัปเดตทุกครั้งที่เข้าสู่ระบบ</p>

      <dl className="mt-4 divide-y divide-line border-t border-line text-sm">
        <InfoRow label="รหัสบุคลากร">
          <span className="tabular-nums">{profile.staffId}</span>
        </InfoRow>
        <InfoRow label="ชื่อ-นามสกุล">{fullNameTh}</InfoRow>
        {profile.firstNameEn && <InfoRow label="ชื่อภาษาอังกฤษ">{fullNameEn}</InfoRow>}
        {profile.positionTh && <InfoRow label="ตำแหน่ง">{profile.positionTh}</InfoRow>}
        {profile.facultyNameTh && <InfoRow label="คณะ/สำนัก">{profile.facultyNameTh}</InfoRow>}
        {profile.departmentNameTh && <InfoRow label="กอง/ฝ่าย">{profile.departmentNameTh}</InfoRow>}
        {profile.programNameTh && <InfoRow label="กลุ่มงาน/สาขา">{profile.programNameTh}</InfoRow>}
        <InfoRow label="อัปเดตล่าสุด">{dateFormatter.format(new Date(profile.syncedAt))}</InfoRow>
      </dl>
    </section>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
      <dt className="text-muted sm:w-32 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
