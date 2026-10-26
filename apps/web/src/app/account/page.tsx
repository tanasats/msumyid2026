import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { BentoGrid, Card } from '@/components/Card';
import { IdentityCard } from '@/components/IdentityCard';
import { LogoutButton } from '@/components/LogoutButton';
import { PageShell } from '@/components/PageShell';
import { StaffProfileCard } from '@/components/StaffProfileCard';
import { TextSizeSwitcher } from '@/components/TextSizeSwitcher';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { ACCOUNT_TYPE_LABELS, getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { getMyStaffProfile } from '@/lib/staff-profile';
import { getTextSize, getThemePreference } from '@/lib/theme-server';

export const metadata: Metadata = { title: 'บัญชีของฉัน' };

// ข้อมูลบัญชีของผู้ใช้ปัจจุบัน + ข้อมูลบุคลากรจาก ERP-HR + ออกจากระบบ (ต้อง login เท่านั้น ไม่ต้องมี permission)
export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);

  const staffProfile = user.accountType === 'staff' ? await getMyStaffProfile() : null;
  const [theme, textSize] = await Promise.all([getThemePreference(), getTextSize()]);

  const isStaff = user.accountType === 'staff';

  // bento (จอใหญ่): บัตรประจำตัว | การแสดงผล (2 ช่อง — ปุ่มเลือกต้องกว้างพอไม่ให้ข้อความตัดบรรทัด)
  //                  ข้อมูลบุคลากร เต็มแถว (เฉพาะบุคลากร) — grid-flow-dense ให้การแสดงผลขึ้นไปอยู่แถวบน
  // tablet: เรียงเต็มความกว้าง / มือถือ: บัตร → ข้อมูลบุคลากร → การแสดงผล
  return (
    <PageShell title="บัญชีของฉัน" user={user}>
      <BentoGrid>
        <IdentityCard
          name={user.name}
          email={user.email}
          pictureUrl={user.pictureUrl}
          accountTypeLabel={ACCOUNT_TYPE_LABELS[user.accountType]}
          className="md:col-span-2 lg:col-span-1"
        />

        {isStaff &&
          (staffProfile ? (
            <StaffProfileCard
              profile={staffProfile}
              description="ข้อมูลจากระบบบุคลากร (ERP) ของมหาวิทยาลัย อัปเดตทุกครั้งที่เข้าสู่ระบบ"
              className="md:col-span-2 lg:col-span-3"
            />
          ) : (
            <Alert tone="info" title="ยังไม่มีข้อมูลบุคลากร" className="md:col-span-2 lg:col-span-3">
              ระบบยังดึงข้อมูลจากระบบบุคลากร (ERP) ไม่สำเร็จ จะลองใหม่เมื่อคุณเข้าสู่ระบบครั้งถัดไป
            </Alert>
          ))}

        <Card title="การแสดงผล" description="เลือกโหมดสว่างหรือมืด หรือให้เปลี่ยนตามการตั้งค่าของเครื่อง" className="md:col-span-2">
          <div className="mt-4">
            <ThemeSwitcher initial={theme} />
          </div>
          <h3 className="mt-6 text-sm font-medium">ขนาดตัวอักษร</h3>
          <div className="mt-2">
            <TextSizeSwitcher initial={textSize} />
          </div>
        </Card>

        <Card
          title="ความเป็นส่วนตัว"
          description="ระบบเก็บและใช้ข้อมูลของคุณอย่างไร เก็บนานเท่าใด และสิทธิของคุณ"
          className="md:col-span-2 lg:col-span-1"
        >
          <Link
            href="/privacy"
            className="mt-4 flex min-h-11 items-center gap-3 rounded-lg border border-line px-4 py-2 font-medium hover:bg-surface-hover"
          >
            <ShieldCheck className="size-5 shrink-0 text-accent" aria-hidden />
            <span className="flex-1">ประกาศความเป็นส่วนตัว</span>
            <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
          </Link>
        </Card>
      </BentoGrid>

      <div className="mt-6 flex md:justify-end">
        <LogoutButton />
      </div>
    </PageShell>
  );
}
