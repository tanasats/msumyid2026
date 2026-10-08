import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { EditUserForm } from '@/components/admin/EditUserForm';
import { PageShell } from '@/components/PageShell';
import { getUserDetail, listOrgUnits } from '@/lib/admin-users';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'แก้ไขข้อมูลผู้ใช้' };

// แก้ไขข้อมูลผู้ใช้ (ต้องมี user:update — API ตรวจตอนบันทึก) หน้าย่อย: มีปุ่มย้อนกลับ ไม่มี bottom nav
export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect('/login');
  if (currentUser.approvalStatus !== 'approved') redirect('/pending');
  if (!currentUser.permissions.includes('user:update')) redirect('/forbidden');

  const { id } = await params;
  const [detail, orgUnits] = await Promise.all([getUserDetail(id), listOrgUnits()]);
  if (!detail) notFound();
  if (!detail.manageable) redirect('/forbidden');

  const { user, staffProfile } = detail;
  // ชื่อที่จะใช้เมื่อไม่ได้ตั้งเอง: ชื่อจาก ERP ถ้ามี ไม่เช่นนั้นชื่อจาก Google
  const fallbackName = staffProfile ? `${staffProfile.firstNameTh} ${staffProfile.lastNameTh}` : user.googleName;

  return (
    <PageShell title="แก้ไขข้อมูลผู้ใช้" backHref={`/admin/users/${user.id}`} user={currentUser} width="form">
      <p className="mb-4 text-muted">
        {user.displayName} · <span className="break-all">{user.email}</span>
      </p>
      <EditUserForm
        userId={user.id}
        fallbackName={fallbackName}
        initial={{
          displayNameOverride: user.displayNameOverride,
          accountType: user.accountType,
          orgUnitId: user.orgUnitId,
        }}
        orgUnits={orgUnits}
      />
    </PageShell>
  );
}
