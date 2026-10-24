'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Tag } from '@/components/UserStatusBadge';
import { apiMutate } from '@/lib/api-client';
import {
  CERTIFICATE_MODE_LABELS,
  certificateModeOf,
  type CertificateRequestMode,
} from '@/lib/primary-certificate-request';
import type { RoleWithAccess } from '@/lib/role-admin';

const MODES: { value: CertificateRequestMode; label: string; hint: string }[] = [
  { value: 'off', label: CERTIFICATE_MODE_LABELS.off, hint: 'ขอใบรับรองประจำตัวไม่ได้' },
  { value: 'apply', label: CERTIFICATE_MODE_LABELS.apply, hint: 'ส่งคำขอแล้วรอผู้อนุมัติ จากนั้นกดรับใบเอง' },
  { value: 'self', label: CERTIFICATE_MODE_LABELS.self, hint: 'กดขอแล้วได้ใบทันที' },
];

const selectClass = 'block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base sm:w-44';

/**
 * วิธีขอใบรับรองประจำตัวของแต่ละบทบาท (super_admin เท่านั้น — API ตรวจ canManageRoles)
 * ผู้ใช้หลายบทบาทได้วิธีที่สะดวกที่สุด (สร้างเองได้ > ส่งคำขอ > ปิด) เพราะสิทธิ์รวมกัน
 */
export function CertificateModeSection({ roles }: { roles: RoleWithAccess[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ role: RoleWithAccess; mode: CertificateRequestMode } | null>(null);
  const editable = roles.filter((r) => !r.hasAllPermissions);

  async function confirm(reason: string) {
    if (!pending) return;
    await apiMutate(`/admin/role-permissions/roles/${pending.role.code}/certificate-mode`, 'PUT', {
      mode: pending.mode,
      reason,
    });
    router.refresh();
  }

  return (
    <section aria-labelledby="certificate-mode" className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <h2 id="certificate-mode" className="font-display text-lg font-semibold">
        ใครขอใบรับรองประจำตัวได้
      </h2>
      <p className="mt-1 text-sm text-muted">
        {MODES.map((m) => `${m.label} = ${m.hint}`).join(' · ')} — ผู้ที่มีหลายบทบาทได้วิธีที่สะดวกที่สุด มีผลทันที
      </p>
      <ul className="mt-4 divide-y divide-line">
        {editable.map((role) => {
          const mode = certificateModeOf(role.permissionCodes);
          return (
            <li key={role.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium break-words">{role.nameTh}</p>
                <p className="text-sm text-muted">
                  <Tag>{role.holderCount} คน</Tag>
                </p>
              </div>
              <label className="sr-only" htmlFor={`certificate-mode-${role.code}`}>
                วิธีขอใบรับรองของ {role.nameTh}
              </label>
              <select
                id={`certificate-mode-${role.code}`}
                value={mode}
                onChange={(e) => setPending({ role, mode: e.target.value as CertificateRequestMode })}
                className={selectClass}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? `ให้${pending.role.nameTh} "${CERTIFICATE_MODE_LABELS[pending.mode]}" หรือไม่?` : ''}
        description={
          pending
            ? `${MODES.find((m) => m.value === pending.mode)!.hint} — มีผลกับผู้ถือบทบาทนี้ ${pending.role.holderCount} คนทันที ใบรับรองที่ออกไปแล้วไม่เปลี่ยน`
            : undefined
        }
        confirmLabel="บันทึก"
        reason="required"
        reasonHint="บันทึกไว้ในประวัติบทบาทและสิทธิ์ เช่น คำสั่งหรือหนังสือที่อ้างอิง"
        onConfirm={confirm}
      />
    </section>
  );
}
