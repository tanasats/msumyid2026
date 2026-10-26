import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { History } from 'lucide-react';
import { CreateRoleButton } from '@/components/admin/CreateRoleButton';
import { RolePermissionCard } from '@/components/admin/RolePermissionCard';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getRoleAdminOverview } from '@/lib/admin-roles';
import { getCurrentUser, redirectUnlessReady } from '@/lib/auth';
import { describeRoleLog } from '@/lib/role-admin';

export const metadata: Metadata = { title: 'บทบาทและสิทธิ์' };

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

// กำหนดบทบาทและสิทธิ์ (super_admin เท่านั้น — API ตรวจ canManageRoles ส่วนเว็บซ่อนลิงก์ด้วย capabilities)
export default async function AdminRolesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  redirectUnlessReady(user);
  if (!user.capabilities.manageRoles) redirect('/forbidden');

  const { roles, permissions, logs } = await getRoleAdminOverview();

  return (
    <PageShell title="บทบาทและสิทธิ์" backHref="/admin/settings" user={user}>
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="text-sm text-muted">
            ผู้ใช้ได้สิทธิ์รวมจากทุกบทบาทที่ถืออยู่ สิทธิ์ใหม่จากการพัฒนาระบบจะยังไม่ผูกกับบทบาทใด (ใช้ได้เฉพาะผู้ดูแลระบบสูงสุด)
            จนกว่าจะกำหนดที่นี่
          </p>
          <div className="shrink-0">
            <CreateRoleButton />
          </div>
        </div>

        <ul className="grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          {roles.map((role) => (
            <RolePermissionCard key={role.id} role={role} permissions={permissions} />
          ))}
        </ul>

        <section aria-labelledby="role-history" className="rounded-xl border border-line bg-surface shadow-card">
          <h2 id="role-history" className="px-5 pt-5 font-display text-lg font-semibold sm:px-6 sm:pt-6">
            ประวัติล่าสุด
          </h2>
          {logs.length === 0 ? (
            <StatusState icon={History} title="ยังไม่มีการเปลี่ยนแปลง">
              การสร้างบทบาท เปลี่ยนชื่อ และให้/ถอนสิทธิ์ จะบันทึกไว้ที่นี่ แก้หรือลบไม่ได้
            </StatusState>
          ) : (
            <ol className="mt-3 divide-y divide-line">
              {logs.map((log) => (
                <li key={log.id} className="px-5 py-4 sm:px-6">
                  <p className="font-medium break-words">{describeRoleLog(log)}</p>
                  <p className="text-sm text-muted">
                    {log.actor?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'} ·{' '}
                    <time dateTime={log.createdAt}>{dateTimeFormatter.format(new Date(log.createdAt))}</time>
                  </p>
                  <p className="mt-1 text-sm break-words">เหตุผล: {log.reason}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </PageShell>
  );
}
