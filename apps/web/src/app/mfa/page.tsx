import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card } from '@/components/Card';
import { LogoutButton } from '@/components/LogoutButton';
import { MfaVerifyForm } from '@/components/mfa/MfaVerifyForm';
import { PageShell } from '@/components/PageShell';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { getCurrentUser, isMfaPending } from '@/lib/auth';
import { getThemePreference } from '@/lib/theme-server';

export const metadata: Metadata = { title: 'ยืนยันตัวตน' };

/**
 * ใส่รหัส MFA หลังผ่าน Google (docs/design/mfa.md) — ทุกหน้าส่งมาที่นี่ด้วย redirectUnlessReady
 * ยังไม่แสดงเมนู: session นี้ยังไม่ได้พิสูจน์ปัจจัยที่สอง (API ไม่คืน role/permission)
 */
export default async function MfaPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!isMfaPending(user)) redirect('/');
  const theme = await getThemePreference();

  return (
    <PageShell title="ยืนยันตัวตนสองขั้นตอน" width="form" headerAction={<ThemeSwitcher initial={theme} compact />}>
      <div className="space-y-6">
        <Card title={user.email} description="เปิดแอป Authenticator ในโทรศัพท์ แล้วใส่รหัส 6 หลักของ MSU Digital ID">
          <div className="mt-4">
            <MfaVerifyForm next="/" />
          </div>
        </Card>
        <p className="text-sm leading-relaxed text-muted">
          โทรศัพท์หายและไม่มีรหัสกู้คืน? ติดต่อผู้ดูแลระบบเพื่อรีเซ็ตการยืนยันตัวตนสองขั้นตอน
        </p>
        <div className="sm:w-56">
          <LogoutButton />
        </div>
      </div>
    </PageShell>
  );
}
