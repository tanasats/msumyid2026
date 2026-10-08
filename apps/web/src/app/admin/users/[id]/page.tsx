import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { History, Pencil } from 'lucide-react';
import { UserAccountActions } from '@/components/admin/UserAccountActions';
import { UserRoleManager } from '@/components/admin/UserRoleManager';
import { Alert } from '@/components/Alert';
import { Avatar } from '@/components/Avatar';
import { buttonClasses } from '@/components/Button';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { StaffProfileCard } from '@/components/StaffProfileCard';
import { StatusState } from '@/components/StatusState';
import { Tag, UserStatusBadge } from '@/components/UserStatusBadge';
import { getUserDetail, listAssignableRoles, type UserHistoryItem } from '@/lib/admin-users';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'รายละเอียดผู้ใช้' };

const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

const USER_ACTION_LABELS: Record<string, string> = {
  create: 'ลงทะเบียนบัญชี',
  update: 'แก้ไขข้อมูล',
  deactivate: 'ปิดบัญชี',
  activate: 'เปิดบัญชีคืน',
  delete: 'ลบข้อมูลส่วนบุคคล',
  approve: 'อนุมัติบัญชี',
  reject: 'ไม่อนุมัติบัญชี',
  link_google: 'ผูกบัญชี Google',
};

function historyLabel(item: UserHistoryItem): string {
  if (item.kind === 'role') {
    return `${item.action === 'grant' ? 'ให้บทบาท' : 'ถอนบทบาท'} ${item.roleNameTh ?? ''}`;
  }
  return USER_ACTION_LABELS[item.action] ?? item.action;
}

// รายละเอียดผู้ใช้ (ต้องมี user:read — API ตรวจ) ปุ่มจัดการแสดงตาม permission เพื่อ UX เท่านั้น
export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect('/login');
  if (currentUser.approvalStatus !== 'approved') redirect('/pending');

  const { id } = await params;
  const [detail, allRoles] = await Promise.all([getUserDetail(id), listAssignableRoles()]);
  if (!detail) notFound();

  const { user, staffProfile, history, manageable, isSelf } = detail;
  const can = (permission: string) => currentUser.permissions.includes(permission);

  return (
    <PageShell title={user.displayName} backHref="/admin/users" user={currentUser} width="form">
      <div className="space-y-6">
        {isSelf && <Alert tone="info">นี่คือบัญชีของคุณ — แก้ไขบทบาทหรือปิดบัญชีของตัวเองไม่ได้</Alert>}

        <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <Avatar name={user.displayName} pictureUrl={user.pictureUrl} size="lg" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold">{user.displayName}</h2>
              <p className="text-sm break-all text-muted">{user.email}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <UserStatusBadge isActive={user.isActive} approvalStatus={user.approvalStatus} />
                <Tag>{ACCOUNT_TYPE_LABELS[user.accountType]}</Tag>
              </div>
            </div>
          </div>

          <InfoList className="mt-6">
            {user.googleName !== user.displayName && <InfoRow label="ชื่อในบัญชี Google">{user.googleName}</InfoRow>}
            <InfoRow label="หน่วยงาน">{user.orgUnitNameTh ?? <span className="text-subtle">ไม่ระบุ</span>}</InfoRow>
            <InfoRow label="เข้าระบบล่าสุด">
              {user.lastLoginAt ? dateTime.format(new Date(user.lastLoginAt)) : <span className="text-subtle">ยังไม่เคย</span>}
            </InfoRow>
            <InfoRow label="สร้างบัญชีเมื่อ">{dateTime.format(new Date(user.createdAt))}</InfoRow>
            {user.approvedAt && (
              <InfoRow label={user.approvalStatus === 'rejected' ? 'ไม่อนุมัติโดย' : 'อนุมัติโดย'}>
                {user.approvedByName ?? 'ระบบ'} · {dateTime.format(new Date(user.approvedAt))}
              </InfoRow>
            )}
            {user.deactivatedAt && (
              <InfoRow label="ปิดบัญชีโดย">
                {user.deactivatedByName ?? 'ระบบ'} · {dateTime.format(new Date(user.deactivatedAt))}
              </InfoRow>
            )}
          </InfoList>

          {manageable && can('user:update') && (
            <Link
              href={`/admin/users/${user.id}/edit`}
              className={`${buttonClasses({ variant: 'secondary', fullWidth: true })} mt-4`}
            >
              <Pencil className="size-5" aria-hidden />
              แก้ไขข้อมูล
            </Link>
          )}
        </section>

        <UserRoleManager
          userId={user.id}
          roles={user.roles}
          allRoles={allRoles}
          assignableCodes={allRoles.filter((r) => r.assignable).map((r) => r.code)}
          editable={!isSelf && can('user_role:assign')}
        />

        {staffProfile && <StaffProfileCard profile={staffProfile} description="ข้อมูลจากระบบบุคลากร (ERP)" />}

        {manageable && (
          <UserAccountActions
            userId={user.id}
            isActive={user.isActive}
            approvalStatus={user.approvalStatus}
            canApprove={can('user:approve')}
            canDeactivate={can('user:deactivate')}
          />
        )}

        <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
          <h2 className="text-lg font-semibold">ประวัติการเปลี่ยนแปลง</h2>
          {history.length === 0 ? (
            <StatusState icon={History} title="ยังไม่มีประวัติ" />
          ) : (
            <ol className="mt-4 space-y-4">
              {history.map((item) => (
                <li key={`${item.kind}-${item.id}`} className="border-l-2 border-line pl-4">
                  <p className="font-medium">{historyLabel(item)}</p>
                  <p className="text-sm text-muted">
                    {item.actorName ?? 'ระบบ'} · <time dateTime={item.createdAt}>{dateTime.format(new Date(item.createdAt))}</time>
                  </p>
                  {item.reason && <p className="mt-1 text-sm">เหตุผล: {item.reason}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </PageShell>
  );
}
