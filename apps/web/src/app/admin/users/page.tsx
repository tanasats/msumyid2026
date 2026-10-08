import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, Search, SearchX, UserPlus } from 'lucide-react';
import { Avatar } from '@/components/Avatar';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { Tag, UserStatusBadge } from '@/components/UserStatusBadge';
import { listUsers, type UserListQuery } from '@/lib/admin-users';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'จัดการผู้ใช้' };

const STATUS_OPTIONS = [
  { value: '', label: 'ทุกสถานะ' },
  { value: 'active', label: 'ใช้งานได้' },
  { value: 'pending', label: 'รออนุมัติ' },
  { value: 'rejected', label: 'ไม่อนุมัติ' },
  { value: 'inactive', label: 'ปิดบัญชี' },
] as const;

const ACCOUNT_TYPE_OPTIONS = [
  { value: '', label: 'ทุกประเภท' },
  { value: 'staff', label: ACCOUNT_TYPE_LABELS.staff },
  { value: 'student', label: ACCOUNT_TYPE_LABELS.student },
  { value: 'external', label: ACCOUNT_TYPE_LABELS.external },
] as const;

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' });

function pick<T extends string>(value: unknown, allowed: readonly { value: string }[]): T | undefined {
  return typeof value === 'string' && value && allowed.some((o) => o.value === value) ? (value as T) : undefined;
}

// หน้ารายชื่อผู้ใช้ (ต้องมี user:read — API ตรวจ ส่วนเว็บซ่อนเมนูเท่านั้น)
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  const params = await searchParams;
  const query: UserListQuery = {
    q: typeof params.q === 'string' ? params.q.trim().slice(0, 100) : undefined,
    status: pick(params.status, STATUS_OPTIONS),
    accountType: pick(params.accountType, ACCOUNT_TYPE_OPTIONS),
    cursor: typeof params.cursor === 'string' ? params.cursor : undefined,
  };
  const { users, nextCursor } = await listUsers(query);

  // ลิงก์หน้าถัดไปคงตัวกรองเดิมไว้
  const filterParams = new URLSearchParams();
  if (query.q) filterParams.set('q', query.q);
  if (query.status) filterParams.set('status', query.status);
  if (query.accountType) filterParams.set('accountType', query.accountType);
  const nextHref = nextCursor ? `/admin/users?${new URLSearchParams([...filterParams, ['cursor', nextCursor]])}` : null;
  const firstHref = `/admin/users?${filterParams}`;

  return (
    <PageShell title="จัดการผู้ใช้" user={user}>
      <div className="space-y-4">
        {user.permissions.includes('user:create') && (
          <div className="flex justify-end">
            <Link href="/admin/users/new" className={buttonClasses({ fullWidth: true })}>
              <UserPlus className="size-5" aria-hidden />
              ลงทะเบียนผู้ใช้
            </Link>
          </div>
        )}

        {/* ฟอร์มค้นหาแบบ GET — ทำงานได้โดยไม่ต้องใช้ JavaScript และแชร์ลิงก์ผลค้นหาได้ */}
        <form method="get" className="space-y-3 rounded-xl border border-line bg-surface p-4 lg:flex lg:items-end lg:gap-3 lg:space-y-0">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="q" className="block text-sm font-medium">
              ค้นหา
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder="ชื่อ หรือ อีเมล"
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base placeholder:text-subtle"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:flex">
            <FilterSelect name="status" label="สถานะ" options={STATUS_OPTIONS} value={query.status} />
            <FilterSelect name="accountType" label="ประเภทบัญชี" options={ACCOUNT_TYPE_OPTIONS} value={query.accountType} />
          </div>
          <button type="submit" className={`${buttonClasses({ fullWidth: true })} w-full lg:w-auto`}>
            <Search className="size-5" aria-hidden />
            ค้นหา
          </button>
        </form>

        {users.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface">
            <StatusState icon={SearchX} title="ไม่พบผู้ใช้ตามเงื่อนไข">
              ลองเปลี่ยนคำค้นหาหรือตัวกรอง
            </StatusState>
          </div>
        ) : (
          <>
            {/* มือถือ/tablet: การ์ด — ทั้งแถวกดได้ */}
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface lg:hidden">
              {users.map((u) => (
                <li key={u.id}>
                  <Link href={`/admin/users/${u.id}`} className="flex min-h-16 items-center gap-3 p-4 hover:bg-slate-50">
                    <Avatar name={u.displayName} pictureUrl={u.pictureUrl} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{u.displayName}</p>
                      <p className="truncate text-sm text-muted">{u.email}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <UserStatusBadge isActive={u.isActive} approvalStatus={u.approvalStatus} />
                        <Tag>{ACCOUNT_TYPE_LABELS[u.accountType]}</Tag>
                      </div>
                    </div>
                    <ChevronRight className="size-5 shrink-0 text-subtle" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>

            {/* desktop: ตาราง */}
            <div className="hidden overflow-hidden rounded-xl border border-line bg-surface lg:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-line bg-slate-50 text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">ผู้ใช้</th>
                    <th scope="col" className="px-4 py-3 font-medium">ประเภท</th>
                    <th scope="col" className="px-4 py-3 font-medium">หน่วยงาน</th>
                    <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
                    <th scope="col" className="px-4 py-3 font-medium">เข้าระบบล่าสุด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link href={`/admin/users/${u.id}`} className="flex items-center gap-3">
                          <Avatar name={u.displayName} pictureUrl={u.pictureUrl} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-primary">{u.displayName}</span>
                            <span className="block truncate text-muted">{u.email}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-4 py-3">{ACCOUNT_TYPE_LABELS[u.accountType]}</td>
                      <td className="px-4 py-3">{u.orgUnitNameTh ?? <span className="text-subtle">—</span>}</td>
                      <td className="px-4 py-3">
                        <UserStatusBadge isActive={u.isActive} approvalStatus={u.approvalStatus} />
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {u.lastLoginAt ? dateFormatter.format(new Date(u.lastLoginAt)) : <span className="text-subtle">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {(nextHref || query.cursor) && (
          <nav aria-label="แบ่งหน้า" className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
            {query.cursor ? (
              <Link href={firstHref} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                กลับหน้าแรก
              </Link>
            ) : (
              <span />
            )}
            {nextHref && (
              <Link href={nextHref} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
                หน้าถัดไป
              </Link>
            )}
          </nav>
        )}
      </div>
    </PageShell>
  );
}

function FilterSelect({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  value: string | undefined;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={value ?? ''}
        className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base lg:w-44"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
