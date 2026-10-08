'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { TextField } from '@/components/TextField';
import type { AccountType, OrgUnit } from '@/lib/admin-users';
import { apiMutate } from '@/lib/api-client';
import { ACCOUNT_TYPE_LABELS } from '@/lib/account-type';

const selectClass = 'block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base disabled:bg-slate-100';

type FieldErrors = Partial<Record<'email' | 'name', string>>;

/**
 * ฟอร์มลงทะเบียนผู้ใช้ล่วงหน้าด้วยอีเมล — บัญชีจะผูกกับ Google เมื่อเจ้าของอีเมลเข้าระบบครั้งแรก
 * ตรวจข้อมูลเบื้องต้นที่ browser (API ตรวจซ้ำเสมอ) และคงข้อมูลที่กรอกไว้เมื่อบันทึกไม่สำเร็จ
 */
export function CreateUserForm({ orgUnits }: { orgUnits: OrgUnit[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('external');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const orgUnitLocked = accountType === 'staff';

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'กรุณากรอกอีเมลให้ถูกต้อง เช่น name@gmail.com';
    if (!name.trim()) errors.name = 'กรุณากรอกชื่อ-นามสกุล';
    return errors;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      document.getElementById(`field-${firstInvalid}`)?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { id } = await apiMutate<{ id: string }>('/admin/users', 'POST', {
        email: email.trim(),
        name: name.trim(),
        accountType,
        orgUnitId: orgUnitLocked ? null : orgUnitId || null,
        reason: reason.trim() || undefined,
      });
      router.push(`/admin/users/${id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      <Alert tone="info">
        บัญชีจะอนุมัติไว้ล่วงหน้า และผูกกับบัญชี Google อัตโนมัติเมื่อเจ้าของอีเมลเข้าสู่ระบบครั้งแรก
        (อีเมล @msu.ac.th ต้องเป็นบัญชีของมหาวิทยาลัยเท่านั้น)
      </Alert>
      {error && <Alert tone="danger">{error}</Alert>}

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 sm:p-6">
        <TextField
          name="email"
          label="อีเมล (บัญชี Google)"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          maxLength={320}
        />
        <TextField
          name="name"
          label="ชื่อ-นามสกุล"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fieldErrors.name}
          hint="ใช้แสดงจนกว่าผู้ใช้จะเข้าสู่ระบบ จากนั้นจะใช้ชื่อจากระบบ ERP หรือบัญชี Google"
          maxLength={200}
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
        </div>

        <div className="space-y-1.5">
          <label htmlFor="field-orgUnitId" className="block text-sm font-medium">
            หน่วยงาน <span className="font-normal text-muted">(ไม่บังคับ)</span>
          </label>
          <select
            id="field-orgUnitId"
            value={orgUnitLocked ? '' : orgUnitId}
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
              ? 'หน่วยงานของบุคลากรมาจากระบบ ERP เมื่อเข้าสู่ระบบครั้งแรก'
              : 'นิสิตและบุคลากรภายนอกกำหนดหน่วยงานได้เอง'}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="field-reason" className="block text-sm font-medium">
            เหตุผล <span className="font-normal text-muted">(ไม่บังคับ)</span>
          </label>
          <textarea
            id="field-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            className="block w-full rounded-lg border border-line-input bg-surface px-3 py-2 text-base"
          />
        </div>
      </section>

      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Link href="/admin/users" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
          ยกเลิก
        </Link>
        <Button type="submit" fullWidth loading={submitting}>
          ลงทะเบียนผู้ใช้
        </Button>
      </div>
    </form>
  );
}
