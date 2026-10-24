import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { History, Pencil } from 'lucide-react';
import { UserAccountActions } from '@/components/admin/UserAccountActions';
import { AdminCertificateCard } from '@/components/certificates/AdminCertificateCard';
import { UserRoleManager } from '@/components/admin/UserRoleManager';
import { Alert } from '@/components/Alert';
import { Avatar } from '@/components/Avatar';
import { buttonClasses } from '@/components/Button';
import { cardClasses } from '@/components/Card';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { StaffProfileCard } from '@/components/StaffProfileCard';
import { StatusState } from '@/components/StatusState';
import { Tag, UserStatusBadge } from '@/components/UserStatusBadge';
import { getUserCertificates } from '@/lib/admin-certificates';
import { getUserDetail, listAssignableRoles, type UserHistoryItem } from '@/lib/admin-users';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'รายละเอียดผู้ใช้' };

const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long' });

function isPast(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

const USER_ACTION_LABELS: Record<string, string> = {
  create: 'ลงทะเบียนบัญชี',
  update: 'แก้ไขข้อมูล',
  deactivate: 'ปิดบัญชี',
  activate: 'เปิดบัญชีคืน',
  delete: 'ลบข้อมูลส่วนบุคคล',
  approve: 'อนุมัติบัญชี',
  reject: 'ไม่อนุมัติบัญชี',
  link_google: 'ผูกบัญชี Google',
  expire: 'ปิดบัญชีอัตโนมัติ (หมดอายุ)',
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
  // บัญชีของตัวเองจัดการได้เมื่อ API บอกว่า manageable (super_admin) — ผู้ดูแลอื่นจัดการตัวเองไม่ได้
  const canActOnSelf = !isSelf || manageable;
  const can = (permission: string) => currentUser.permissions.includes(permission);
  // ใบรับรองแสดงเฉพาะผู้มี certificate:read (API ตรวจซ้ำ)
  const certificates = can('certificate:read') ? await getUserCertificates(user.id) : null;
  const isService = user.accountType === 'service';
  const isUnclassified = user.accountType === 'unclassified';
  // บัญชีหน่วยงานต้องกำหนดหน่วยงานและผู้รับผิดชอบก่อนอนุมัติ / บัญชีรอจำแนกต้องเลือกประเภทก่อน (API ตรวจซ้ำ)
  const missingForApproval = isUnclassified
    ? ['ประเภทบัญชี']
    : isService
      ? [!user.orgUnitId && 'หน่วยงาน', !user.responsibleUser && 'ผู้รับผิดชอบ'].filter((v): v is string => Boolean(v))
      : [];

  return (
    <PageShell title={user.displayName} backHref="/admin/users" user={currentUser}>
      <div className="space-y-6">
        {isSelf && (
          <Alert tone="info">
            {manageable
              ? 'นี่คือบัญชีของคุณ — ในฐานะผู้ดูแลระบบสูงสุด คุณจัดการบัญชีนี้ได้ทุกอย่าง ถ้าปิดหรือลบบัญชี คุณจะออกจากระบบทันที'
              : 'นี่คือบัญชีของคุณ — แก้ไขบทบาทหรือปิดบัญชีของตัวเองไม่ได้'}
          </Alert>
        )}
        {!user.hasGoogleAccount && (
          <Alert tone="info" title="ลงทะเบียนล่วงหน้า — ยังไม่เคยเข้าสู่ระบบ">
            บัญชีจะผูกกับบัญชี Google อัตโนมัติเมื่อผู้ใช้เข้าสู่ระบบด้วยอีเมล {user.email} ครั้งแรก
          </Alert>
        )}
        {user.approvalStatus !== 'approved' && missingForApproval.length > 0 && (
          <Alert tone="warning" title="ยังอนุมัติไม่ได้">
            {isUnclassified
              ? 'ระบบ ERP ไม่พบบัญชีนี้ อาจเป็นบุคลากรภายนอก (เช่น อาจารย์พิเศษ ผู้เชี่ยวชาญ) หรือบัญชีหน่วยงาน — กด "แก้ไขข้อมูล" เพื่อเลือกประเภทบัญชีก่อน'
              : `บัญชีหน่วยงานต้องกำหนด${missingForApproval.join('และ')}ก่อน — กด "แก้ไขข้อมูล" เพื่อกำหนด`}
          </Alert>
        )}

        {/* จอใหญ่: ซ้าย = ตัวตน + ปุ่มจัดการ (ติดค้างขณะเลื่อน) / ขวา = บทบาท ข้อมูลบุคลากร ใบรับรอง ประวัติ */}
        <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
          <div className="space-y-6 lg:sticky lg:top-20">
            <section className={cardClasses}>
              <div className="flex items-center gap-4">
                <Avatar name={user.displayName} pictureUrl={user.pictureUrl} size="lg" />
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold">{user.displayName}</h2>
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
                {isService && (
                  <InfoRow label="ผู้รับผิดชอบ">
                    {user.responsibleUser ? (
                      <Link href={`/admin/users/${user.responsibleUser.id}`} className="text-accent underline">
                        {user.responsibleUser.displayName}
                      </Link>
                    ) : (
                      <span className="text-subtle">ยังไม่กำหนด</span>
                    )}
                  </InfoRow>
                )}
                {isService && (
                  <InfoRow label="วันหมดอายุ">
                    {user.accountExpiresAt ? (
                      <>
                        {dateOnly.format(new Date(user.accountExpiresAt))}
                        {isPast(user.accountExpiresAt) && <span className="text-danger-fg"> (หมดอายุแล้ว)</span>}
                      </>
                    ) : (
                      <span className="text-subtle">ไม่หมดอายุ</span>
                    )}
                  </InfoRow>
                )}
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

            {manageable && (
              <UserAccountActions
                userId={user.id}
                email={user.email}
                isActive={user.isActive}
                approvalStatus={user.approvalStatus}
                accountType={user.accountType}
                approveBlockedReason={
                  missingForApproval.length > 0 ? `กำหนด${missingForApproval.join('และ')}ก่อนจึงจะอนุมัติได้` : undefined
                }
                canApprove={can('user:approve')}
                canDeactivate={can('user:deactivate')}
                canDelete={can('user:delete')}
                isSelf={isSelf}
              />
            )}
          </div>

          <div className="space-y-6 lg:col-span-2">
            <UserRoleManager
              userId={user.id}
              roles={user.roles}
              allRoles={allRoles}
              assignableCodes={allRoles.filter((r) => r.assignable).map((r) => r.code)}
              editable={canActOnSelf && can('user_role:assign')}
            />

            {staffProfile && <StaffProfileCard profile={staffProfile} description="ข้อมูลจากระบบบุคลากร (ERP)" />}

            {certificates && (
              <section className="space-y-3">
                <h2 className="font-display text-lg font-semibold">ใบรับรอง</h2>
                {certificates.length === 0 ? (
                  <p className="rounded-xl border border-line bg-surface shadow-card p-5 text-sm text-muted">ผู้ใช้นี้ยังไม่มีใบรับรอง</p>
                ) : (
                  <ul className="space-y-3">
                    {certificates.map((c) => (
                      <AdminCertificateCard
                        key={c.id}
                        certificate={c}
                        canRevoke={canActOnSelf && can('certificate:revoke')}
                        canViewOwner={false}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className={cardClasses}>
              <h2 className="font-display text-lg font-semibold">ประวัติการเปลี่ยนแปลง</h2>
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
        </div>
      </div>
    </PageShell>
  );
}
