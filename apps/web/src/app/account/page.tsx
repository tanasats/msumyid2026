import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { Avatar } from '@/components/Avatar';
import { InfoList, InfoRow } from '@/components/InfoList';
import { LogoutButton } from '@/components/LogoutButton';
import { PageShell } from '@/components/PageShell';
import { StaffProfileCard } from '@/components/StaffProfileCard';
import { TextSizeSwitcher } from '@/components/TextSizeSwitcher';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { Tag } from '@/components/UserStatusBadge';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';
import { getMyStaffProfile } from '@/lib/staff-profile';
import { getTextSize, getThemePreference } from '@/lib/theme-server';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

// ข้อมูลบัญชีของผู้ใช้ปัจจุบัน + ข้อมูลบุคลากรจาก ERP-HR + ออกจากระบบ (ต้อง login เท่านั้น ไม่ต้องมี permission)
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  const staffProfile = user.accountType === 'staff' ? await getMyStaffProfile() : null;
  const [theme, textSize] = await Promise.all([getThemePreference(), getTextSize()]);

  return (
    <PageShell title="บัญชีของฉัน" user={user} width="form">
      <div className="space-y-6">
        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <Avatar name={user.name} pictureUrl={user.pictureUrl} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate font-display text-lg font-semibold">{user.name}</h2>
              <p className="text-sm break-all text-muted">{user.email}</p>
            </div>
          </div>

          <InfoList className="mt-6">
            <InfoRow label="ประเภทบัญชี">{ACCOUNT_TYPE_LABELS[user.accountType]}</InfoRow>
            <InfoRow label="บทบาท">
              <span className="flex flex-wrap gap-2">
                {user.roles.map((role) => (
                  <Tag key={role}>{role}</Tag>
                ))}
              </span>
            </InfoRow>
          </InfoList>
        </section>

        {user.accountType === 'staff' &&
          (staffProfile ? (
            <StaffProfileCard
              profile={staffProfile}
              description="ข้อมูลจากระบบบุคลากร (ERP) ของมหาวิทยาลัย อัปเดตทุกครั้งที่เข้าสู่ระบบ"
            />
          ) : (
            <Alert tone="info" title="ยังไม่มีข้อมูลบุคลากร">
              ระบบยังดึงข้อมูลจากระบบบุคลากร (ERP) ไม่สำเร็จ จะลองใหม่เมื่อคุณเข้าสู่ระบบครั้งถัดไป
            </Alert>
          ))}

        <section className="rounded-xl border border-line bg-surface shadow-card p-5 shadow-card sm:p-6">
          <h2 className="font-display text-lg font-semibold">การแสดงผล</h2>
          <p className="mt-1 text-sm text-muted">เลือกโหมดสว่างหรือมืด หรือให้เปลี่ยนตามการตั้งค่าของเครื่อง</p>
          <div className="mt-4">
            <ThemeSwitcher initial={theme} />
          </div>
          <h3 className="mt-6 text-sm font-medium">ขนาดตัวอักษร</h3>
          <div className="mt-2">
            <TextSizeSwitcher initial={textSize} />
          </div>
        </section>

        <LogoutButton />
      </div>
    </PageShell>
  );
}

