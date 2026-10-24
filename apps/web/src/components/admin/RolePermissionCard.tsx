'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, Pencil } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { Tag } from '@/components/UserStatusBadge';
import { apiMutate } from '@/lib/api-client';
import type { PermissionInfo, RoleWithAccess } from '@/lib/role-admin';

/**
 * role หนึ่งรายการ: ชื่อ ผู้ถือ และสิทธิ์ที่ผูกอยู่ — กด "แก้ไข" เพื่อเปลี่ยนชื่อและเลือกสิทธิ์ทั้งชุด พร้อมเหตุผล
 * สิทธิ์มีผลกับผู้ถือ role ทันทีที่บันทึก (API อ่านสิทธิ์จากฐานข้อมูลทุก request)
 */
export function RolePermissionCard({ role, permissions }: { role: RoleWithAccess; permissions: PermissionInfo[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [nameTh, setNameTh] = useState(role.nameTh);
  const [selected, setSelected] = useState<Set<string>>(new Set(role.permissionCodes));
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const descriptions = new Map(permissions.map((p) => [p.code, p.descriptionTh]));
  const nameChanged = nameTh.trim() !== role.nameTh;
  const permissionsChanged =
    selected.size !== role.permissionCodes.length || role.permissionCodes.some((code) => !selected.has(code));

  function startEditing() {
    setNameTh(role.nameTh);
    setSelected(new Set(role.permissionCodes));
    setReason('');
    setReasonError(null);
    setError(null);
    setEditing(true);
  }

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!nameTh.trim()) {
      setError('กรุณากรอกชื่อบทบาท');
      return;
    }
    if (!reason.trim()) {
      setReasonError('กรุณาระบุเหตุผล เช่น คำสั่งหรือหนังสือที่อ้างอิง');
      document.getElementById(`role-reason-${role.code}`)?.focus();
      return;
    }
    if (!nameChanged && !permissionsChanged) {
      setError('ยังไม่ได้เปลี่ยนอะไร');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (nameChanged) {
        await apiMutate(`/admin/role-permissions/roles/${role.code}`, 'PATCH', { nameTh: nameTh.trim(), reason: reason.trim() });
      }
      if (permissionsChanged) {
        await apiMutate(`/admin/role-permissions/roles/${role.code}/permissions`, 'PUT', {
          permissions: [...selected],
          reason: reason.trim(),
        });
      }
      setEditing(false);
      router.refresh();
    } catch (err) {
      // คงค่าที่เลือกไว้ ให้แก้แล้วบันทึกใหม่ได้
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold break-words">{role.nameTh}</p>
          <p className="font-mono text-xs text-muted">{role.code}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {role.isSystem && <Tag>บทบาทระบบ</Tag>}
          {role.isPrivileged && <Tag strong>สิทธิ์สูง</Tag>}
          <Tag>{role.holderCount} คน</Tag>
        </div>
      </div>

      {role.hasAllPermissions ? (
        <p className="mt-3 text-sm text-muted">ได้รับทุกสิทธิ์ในระบบโดยอัตโนมัติ รวมสิทธิ์ที่เพิ่มในอนาคต</p>
      ) : !editing ? (
        <>
          {role.permissionCodes.length === 0 ? (
            <p className="mt-3 text-sm text-muted">ยังไม่มีสิทธิ์</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {role.permissionCodes.map((code) => (
                <li key={code}>
                  <span className="font-mono text-xs">{code}</span>
                  <span className="text-muted"> — {descriptions.get(code)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex justify-end border-t border-line pt-4">
            <Button variant="secondary" size="sm" fullWidth onClick={startEditing}>
              <Pencil className="size-4" aria-hidden />
              แก้ไข
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={save} noValidate className="mt-4 space-y-4 border-t border-line pt-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <TextField
            name={`role-name-${role.code}`}
            label="ชื่อบทบาท"
            value={nameTh}
            onChange={(e) => setNameTh(e.target.value)}
            maxLength={100}
          />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">สิทธิ์</legend>
            {permissions.map((p) => (
              <label
                key={p.code}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.code)}
                  onChange={() => toggle(p.code)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />
                <span className="text-sm">
                  <span className="block font-mono text-xs">{p.code}</span>
                  <span className="block">{p.descriptionTh}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="space-y-1.5">
            <label htmlFor={`role-reason-${role.code}`} className="block text-sm font-medium">
              เหตุผล
            </label>
            <textarea
              id={`role-reason-${role.code}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={500}
              aria-invalid={reasonError ? true : undefined}
              className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base ${reasonError ? 'border-danger' : 'border-line-input'}`}
            />
            {reasonError ? (
              <p className="flex items-start gap-1.5 text-sm text-danger-fg">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {reasonError}
              </p>
            ) : (
              <p className="text-sm text-muted">
                บันทึกในประวัติ มีผลกับผู้ถือบทบาท {role.holderCount} คนทันที
              </p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="secondary" fullWidth onClick={() => setEditing(false)} disabled={saving}>
              ยกเลิก
            </Button>
            <Button type="submit" fullWidth loading={saving}>
              บันทึก
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
