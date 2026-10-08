'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { TextField } from '@/components/TextField';
import type { AccountType, OrgUnit } from '@/lib/admin-users';
import { apiMutate } from '@/lib/api-client';
import { ACCOUNT_TYPE_LABELS } from '@/lib/auth';

type EditUserFormProps = {
  userId: string;
  /** ชื่อที่ใช้เมื่อไม่ได้ตั้งเอง (จาก ERP/Google) — แสดงเป็นคำแนะนำ */
  fallbackName: string;
  initial: { displayNameOverride: string | null; accountType: AccountType; orgUnitId: string | null };
  orgUnits: OrgUnit[];
};

const selectClass = 'block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base disabled:bg-slate-100';

/**
 * ฟอร์มแก้ไขข้อมูลผู้ใช้ — ส่งเฉพาะช่องที่เปลี่ยนจริง (API ตอบ NO_CHANGES ถ้าไม่มีอะไรเปลี่ยน)
 * มือถือ: ปุ่มติดด้านล่างจอ (sticky action bar) ใกล้นิ้วโป้ง
 */
export function EditUserForm({ userId, fallbackName, initial, orgUnits }: EditUserFormProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayNameOverride ?? '');
  const [accountType, setAccountType] = useState<AccountType>(initial.accountType);
  const [orgUnitId, setOrgUnitId] = useState(initial.orgUnitId ?? '');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // หน่วยงานของบุคลากรมาจาก ERP ทุกครั้งที่ login จึงแก้เองไม่ได้
  const orgUnitLocked = accountType === 'staff';

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setReasonError('กรุณาระบุเหตุผลของการแก้ไข');
      document.getElementById('field-reason')?.focus();
      return;
    }
    setReasonError(null);

    const body: Record<string, unknown> = { reason };
    if (displayName.trim() !== (initial.displayNameOverride ?? '')) body.displayNameOverride = displayName.trim();
    if (accountType !== initial.accountType) body.accountType = accountType;
    if (!orgUnitLocked && orgUnitId !== (initial.orgUnitId ?? '')) body.orgUnitId = orgUnitId || null;

    if (Object.keys(body).length === 1) {
      setError('ยังไม่ได้แก้ไขข้อมูลใด');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await apiMutate(`/admin/users/${userId}`, 'PATCH', body);
      router.push(`/admin/users/${userId}`);
      router.refresh();
    } catch (err) {
      // คงข้อมูลที่กรอกไว้ ไม่ล้างฟอร์ม
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <TextField
          name="displayNameOverride"
          label="ชื่อแสดงในระบบ"
          optional
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={200}
          autoComplete="off"
          hint={`เว้นว่างเพื่อใช้ชื่อจากระบบ ERP หรือบัญชี Google (${fallbackName}) ชื่อที่ตั้งเองจะไม่ถูกทับเมื่อผู้ใช้เข้าสู่ระบบ`}
        />

        <div className="space-y-1.5">
          <label htmlFor="field-accountType" className="block text-sm font-medium">
            ประเภทบัญชี
          </label>
          <select
            id="field-accountType"
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
            className={selectClass}
          >
            {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {accountType !== initial.accountType && (
            <p className="text-sm text-amber-800">
              บทบาท &quot;{ACCOUNT_TYPE_LABELS[initial.accountType]}&quot; จะถูกถอน และให้บทบาท &quot;
              {ACCOUNT_TYPE_LABELS[accountType]}&quot; แทน
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="field-orgUnitId" className="block text-sm font-medium">
            หน่วยงาน
          </label>
          <select
            id="field-orgUnitId"
            value={orgUnitId}
            onChange={(e) => setOrgUnitId(e.target.value)}
            disabled={orgUnitLocked}
            aria-describedby="field-orgUnitId-hint"
            className={selectClass}
          >
            <option value="">ไม่ระบุ</option>
            {orgUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.nameTh}
              </option>
            ))}
          </select>
          <p id="field-orgUnitId-hint" className="text-sm text-muted">
            {orgUnitLocked
              ? 'หน่วยงานของบุคลากรมาจากระบบ ERP อัตโนมัติทุกครั้งที่เข้าสู่ระบบ'
              : 'นิสิตและบุคลากรภายนอกกำหนดหน่วยงานได้เอง'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="field-reason" className="block text-sm font-medium">
            เหตุผลของการแก้ไข
          </label>
          <textarea
            id="field-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? 'field-reason-error' : 'field-reason-hint'}
            className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base ${
              reasonError ? 'border-red-700' : 'border-line-input'
            }`}
          />
          {reasonError ? (
            <p id="field-reason-error" className="text-sm text-red-800">
              {reasonError}
            </p>
          ) : (
            <p id="field-reason-hint" className="text-sm text-muted">
              บันทึกไว้ในประวัติของบัญชีนี้
            </p>
          )}
        </div>
      </section>

      {/* มือถือ: ติดด้านล่างจอ / จอใหญ่: ท้ายฟอร์มชิดขวา */}
      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Link href={`/admin/users/${userId}`} className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
          ยกเลิก
        </Link>
        <Button type="submit" fullWidth loading={submitting}>
          บันทึกการแก้ไข
        </Button>
      </div>
    </form>
  );
}
