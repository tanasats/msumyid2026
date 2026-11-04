'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Tag } from '@/components/UserStatusBadge';
import { apiMutate } from '@/lib/api-client';
import type { RoleWithAccess } from '@/lib/role-admin';

const selectClass = 'block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base sm:w-44';

/**
 * บังคับการยืนยันตัวตนสองขั้นตอน (MFA) ต่อบทบาท (super_admin เท่านั้น — API ตรวจ canManageRoles)
 * ผู้ถือบทบาทที่บังคับ: ยังไม่ตั้งค่า → ต้องตั้งค่าก่อนใช้ระบบ, ตั้งแล้ว → ปิดเองไม่ได้
 * เลิกบังคับต้องยืนยันตัวตนซ้ำเสมอ (StepUpDialog เปิดให้เองผ่าน apiMutate)
 */
export function MfaRequirementSection({ roles }: { roles: RoleWithAccess[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ role: RoleWithAccess; required: boolean } | null>(null);

  async function confirm(reason: string) {
    if (!pending) return;
    await apiMutate(`/admin/role-permissions/roles/${pending.role.code}/mfa-required`, 'PUT', {
      required: pending.required,
      reason,
    });
    router.refresh();
  }

  return (
    <section aria-labelledby="mfa-required" className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 id="mfa-required" className="font-display text-lg font-semibold">
        บังคับการยืนยันตัวตนสองขั้นตอน
      </h2>
      <p className="mt-1 text-sm text-muted">
        ผู้ถือบทบาทที่บังคับต้องตั้งค่าแอป Authenticator ก่อนใช้ระบบและปิดเองไม่ได้ (ผู้ที่มีหลายบทบาท บังคับถ้ามีบทบาทใดบังคับ)
        บทบาทอื่นเปิดใช้เองได้ที่หน้าบัญชีของฉัน
      </p>
      <ul className="mt-4 divide-y divide-line">
        {roles.map((role) => (
          <li key={role.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium break-words">{role.nameTh}</p>
              <p className="text-sm text-muted">
                <Tag>{role.holderCount} คน</Tag>
              </p>
            </div>
            <label className="sr-only" htmlFor={`mfa-required-${role.code}`}>
              บังคับการยืนยันตัวตนสองขั้นตอนกับ {role.nameTh}
            </label>
            <select
              id={`mfa-required-${role.code}`}
              value={role.mfaRequired ? 'on' : 'off'}
              onChange={(e) => setPending({ role, required: e.target.value === 'on' })}
              className={selectClass}
            >
              <option value="off">ไม่บังคับ</option>
              <option value="on">บังคับ</option>
            </select>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending
            ? pending.required
              ? `บังคับการยืนยันตัวตนสองขั้นตอนกับ${pending.role.nameTh}หรือไม่?`
              : `เลิกบังคับการยืนยันตัวตนสองขั้นตอนกับ${pending.role.nameTh}หรือไม่?`
            : ''
        }
        description={
          pending
            ? pending.required
              ? `ผู้ถือบทบาทนี้ ${pending.role.holderCount} คนที่ยังไม่ตั้งค่า จะต้องตั้งค่าแอป Authenticator ก่อนใช้งานในหน้าถัดไปทันที`
              : `ผู้ถือบทบาทนี้ ${pending.role.holderCount} คนจะปิดการยืนยันตัวตนสองขั้นตอนเองได้ (ถ้าไม่มีบทบาทอื่นที่บังคับ) — ต้องยืนยันตัวตนอีกครั้ง`
            : undefined
        }
        confirmLabel={pending?.required ? 'บังคับใช้' : 'เลิกบังคับ'}
        tone={pending?.required === false ? 'danger' : 'primary'}
        reason="required"
        reasonHint="บันทึกไว้ในประวัติบทบาทและสิทธิ์ เช่น คำสั่งหรือนโยบายที่อ้างอิง"
        onConfirm={confirm}
      />
    </section>
  );
}
