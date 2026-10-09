import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CreateUserForm } from '@/components/admin/CreateUserForm';
import { PageShell } from '@/components/PageShell';
import { listOrgUnits } from '@/lib/admin-users';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'ลงทะเบียนผู้ใช้' };

// ลงทะเบียนผู้ใช้ล่วงหน้า (ต้องมี user:create — API ตรวจตอนบันทึก) หน้าย่อย: มีปุ่มย้อนกลับ ไม่มี bottom nav
export default async function NewUserPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect('/login');
  if (currentUser.approvalStatus !== 'approved') redirect('/pending');
  if (!currentUser.permissions.includes('user:create')) redirect('/forbidden');

  const orgUnits = await listOrgUnits();

  return (
    <PageShell title="ลงทะเบียนผู้ใช้" backHref="/admin/users" user={currentUser} width="form">
      <CreateUserForm orgUnits={orgUnits} />
    </PageShell>
  );
}
