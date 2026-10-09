'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Tag } from '@/components/UserStatusBadge';
import { apiMutate } from '@/lib/api-client';

type RoleOption = { code: string; nameTh: string; isPrivileged: boolean };

type Pending = { kind: 'grant' | 'revoke'; role: RoleOption };

/**
 * แสดง/ให้/ถอน role ของผู้ใช้
 * assignableCodes = role ที่ผู้ใช้ปัจจุบันให้/ถอนได้ (จาก API /admin/roles) — ซ่อนปุ่มเพื่อ UX เท่านั้น
 */
export function UserRoleManager({
  userId,
  roles,
  allRoles,
  assignableCodes,
  editable,
}: {
  userId: string;
  roles: RoleOption[];
  allRoles: RoleOption[];
  assignableCodes: string[];
  /** false = ดูอย่างเดียว (ไม่มีสิทธิ์ user_role:assign หรือเป็นบัญชีของตัวเอง) */
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Pending | null>(null);
  const [selected, setSelected] = useState('');

  const held = new Set(roles.map((r) => r.code));
  const grantable = editable ? allRoles.filter((r) => assignableCodes.includes(r.code) && !held.has(r.code)) : [];

  async function confirm(reason: string) {
    if (!pending) return;
    await apiMutate(
      `/admin/users/${userId}/roles/${pending.role.code}`,
      pending.kind === 'grant' ? 'POST' : 'DELETE',
      { reason },
    );
    setSelected('');
    router.refresh();
  }

  return (
    <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold">บทบาท</h2>
      <p className="mt-1 text-sm text-muted">
        บทบาทประเภทบัญชี (ผู้ใช้งานทั่วไป, นิสิต, บุคลากร, บุคลากรภายนอก) ระบบกำหนดให้อัตโนมัติ
      </p>

      <ul className="mt-4 flex flex-wrap gap-2">
        {roles.map((role) => {
          const removable = editable && assignableCodes.includes(role.code);
          return (
            <li key={role.code} className="flex items-center">
              <Tag strong={role.isPrivileged}>
                {role.nameTh}
                {removable && (
                  <button
                    type="button"
                    onClick={() => setPending({ kind: 'revoke', role })}
                    aria-label={`ถอนบทบาท ${role.nameTh}`}
                    // พื้นที่แตะขยายด้วย padding/margin ติดลบ ให้ถึง 44px โดยป้ายไม่ใหญ่ขึ้น
                    className="-my-3 -mr-2 ml-1 flex size-11 items-center justify-center rounded-full hover:bg-surface-hover"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                )}
              </Tag>
            </li>
          );
        })}
      </ul>

      {grantable.length > 0 && (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <label htmlFor="grant-role" className="block text-sm font-medium">
              เพิ่มบทบาท
            </label>
            <select
              id="grant-role"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base"
            >
              <option value="">เลือกบทบาท</option>
              {grantable.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.nameTh}
                  {r.isPrivileged ? ' (สิทธิ์สูง)' : ''}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="secondary"
            fullWidth
            disabled={!selected}
            onClick={() => {
              const role = grantable.find((r) => r.code === selected);
              if (role) setPending({ kind: 'grant', role });
            }}
          >
            <Plus className="size-5" aria-hidden />
            เพิ่ม
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending?.kind === 'grant'
            ? `ให้บทบาท "${pending.role.nameTh}" หรือไม่?`
            : `ถอนบทบาท "${pending?.role.nameTh ?? ''}" หรือไม่?`
        }
        description={
          pending?.role.isPrivileged ? 'บทบาทนี้เป็นสิทธิ์สูง ผู้ถือจะจัดการระบบได้ในวงกว้าง' : 'สิทธิ์ของผู้ใช้จะเปลี่ยนทันที'
        }
        confirmLabel={pending?.kind === 'grant' ? 'ให้บทบาท' : 'ถอนบทบาท'}
        tone={pending?.kind === 'revoke' ? 'danger' : 'primary'}
        reason="required"
        onConfirm={confirm}
      />
    </section>
  );
}
