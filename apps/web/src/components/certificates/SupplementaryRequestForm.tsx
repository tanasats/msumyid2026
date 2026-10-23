'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { InfoList, InfoRow } from '@/components/InfoList';
import { apiMutate } from '@/lib/api-client';
import { validateRange, type SupplementaryLimits } from '@/lib/supplementary-certificate';
import { DateRangeFields, type DateRangeErrors } from './DateRangeFields';

const MAX_PURPOSE_LENGTH = 1000;

type FieldErrors = DateRangeErrors & { purpose?: string };

/** id ของช่องตามลำดับในฟอร์ม (TextField ใช้ field-{name}, DateRangeFields ตั้ง name จาก idPrefix "request") */
const FIELD_IDS: Record<keyof FieldErrors, string> = {
  purpose: 'field-purpose',
  startDate: 'field-requestStartDate',
  endDate: 'field-requestEndDate',
};

/**
 * ฟอร์มขอใบรับรองเสริม: วัตถุประสงค์ + ช่วงวันที่ใช้งาน แล้วรอผู้อนุมัติ
 * ชื่อและอีเมลในใบมาจากบัญชี (API กำหนดเอง) — ตั้งรหัส .p12 ตอนรับใบหลังได้รับอนุมัติ
 */
export function SupplementaryRequestForm({
  name,
  email,
  limits,
}: {
  name: string;
  email: string;
  limits: SupplementaryLimits;
}) {
  const router = useRouter();
  const [purpose, setPurpose] = useState('');
  const [range, setRange] = useState({ startDate: limits.today, endDate: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!purpose.trim()) errors.purpose = 'กรุณาระบุว่าจะใช้ใบรับรองลงนามเอกสารอะไร';
    const rangeError = validateRange(range, limits, 'submit');
    if (rangeError) errors[rangeError.field] = rangeError.message;
    return errors;
  }

  // ตรวจช่วงวันที่เมื่อออกจากช่อง เฉพาะเมื่อกรอกครบแล้ว (ไม่ขึ้น error ระหว่างเลือก)
  function validateRangeOnBlur() {
    if (!range.startDate || !range.endDate) return;
    const { startDate, endDate } = validate();
    setFieldErrors((prev) => ({ ...prev, startDate, endDate }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    const firstInvalid = (Object.keys(FIELD_IDS) as (keyof FieldErrors)[]).find((key) => errors[key]);
    if (firstInvalid) {
      document.getElementById(FIELD_IDS[firstInvalid])?.focus();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await apiMutate('/me/supplementary-certificate-requests', 'POST', { purpose: purpose.trim(), ...range });
      router.push('/certificates?requested=1');
      router.refresh();
    } catch (err) {
      // คงข้อมูลที่กรอกไว้ ให้แก้แล้วส่งใหม่ได้
      setError(err instanceof Error ? err.message : 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold">ข้อมูลในใบรับรอง</h2>
        <p className="mt-1 text-sm text-muted">มาจากบัญชีของคุณ ใบรับรองเสริมใช้ลงนามเอกสารเท่านั้น ใช้กับอีเมลไม่ได้</p>
        <InfoList className="mt-4">
          <InfoRow label="ชื่อ">{name}</InfoRow>
          <InfoRow label="อีเมล">
            <span className="break-all">{email}</span>
          </InfoRow>
        </InfoList>
      </section>

      <section className="space-y-5 rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold">รายละเอียดคำขอ</h2>
        <div className="space-y-1.5">
          <label htmlFor="field-purpose" className="block text-sm font-medium">
            วัตถุประสงค์
          </label>
          <textarea
            id="field-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            onBlur={() => purpose && setFieldErrors((prev) => ({ ...prev, purpose: validate().purpose }))}
            rows={3}
            maxLength={MAX_PURPOSE_LENGTH}
            aria-invalid={fieldErrors.purpose ? true : undefined}
            aria-describedby={fieldErrors.purpose ? 'field-purpose-hint field-purpose-error' : 'field-purpose-hint'}
            className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base ${
              fieldErrors.purpose ? 'border-danger' : 'border-line-input'
            }`}
          />
          <p id="field-purpose-hint" className="text-sm text-muted">
            เช่น ลงนามเกียรติบัตรงานประชุมวิชาการ — ผู้อนุมัติใช้พิจารณา ห้ามใส่ข้อมูลส่วนบุคคลของผู้อื่น
          </p>
          {fieldErrors.purpose && (
            <p id="field-purpose-error" className="flex items-start gap-1.5 text-sm text-danger-fg">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {fieldErrors.purpose}
            </p>
          )}
        </div>

        <DateRangeFields
          idPrefix="request"
          {...range}
          onChange={setRange}
          onBlur={validateRangeOnBlur}
          limits={limits}
          errors={fieldErrors}
        />
      </section>

      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Link href="/certificates" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
          ยกเลิก
        </Link>
        <Button type="submit" fullWidth loading={submitting}>
          ส่งคำขอ
        </Button>
      </div>
    </form>
  );
}
