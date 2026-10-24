'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { apiMutate } from '@/lib/api-client';
import type { SystemSettingsValues } from '@/lib/system-settings';

const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

type NumberKey = Exclude<keyof SystemSettingsValues, 'allowedEmailDomains'>;
type FieldErrors = Partial<Record<NumberKey | 'allowedEmailDomains' | 'reason', string>>;

/** โดเมนจากช่องข้อความ (คั่นด้วยจุลภาค/ขึ้นบรรทัดใหม่) — ตัวพิมพ์เล็ก ไม่ซ้ำ */
function parseDomains(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

/**
 * ฟอร์มค่าตั้งของระบบ (super_admin) — มีผลทันทีที่บันทึก ไม่ต้อง restart
 * API ตรวจค่าและความสัมพันธ์ของค่าอีกครั้งตอนบันทึก
 */
export function SystemSettingsForm({ initial }: { initial: SystemSettingsValues }) {
  const router = useRouter();
  const [domains, setDomains] = useState(initial.allowedEmailDomains.join(', '));
  const [values, setValues] = useState<Record<NumberKey, string>>({
    sessionTtlDays: String(initial.sessionTtlDays),
    crlValidityDays: String(initial.crlValidityDays),
    crlReissueHours: String(initial.crlReissueHours),
  });
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: NumberKey) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: event.target.value }));
  };

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const parsed = parseDomains(domains);
    if (parsed.length === 0) errors.allowedEmailDomains = 'กรุณากรอกอย่างน้อย 1 โดเมน เช่น msu.ac.th';
    else if (parsed.some((d) => !DOMAIN_PATTERN.test(d))) {
      errors.allowedEmailDomains = 'รูปแบบโดเมนไม่ถูกต้อง กรอกเฉพาะชื่อโดเมน เช่น msu.ac.th (ไม่ต้องมี @)';
    }
    const ttl = Number(values.sessionTtlDays);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30) errors.sessionTtlDays = 'กรอกจำนวนวัน 1–30';
    const validity = Number(values.crlValidityDays);
    if (!Number.isInteger(validity) || validity < 1 || validity > 30) errors.crlValidityDays = 'กรอกจำนวนวัน 1–30';
    const reissue = Number(values.crlReissueHours);
    if (!Number.isInteger(reissue) || reissue < 1 || reissue > 168) errors.crlReissueHours = 'กรอกจำนวนชั่วโมง 1–168';
    else if (!errors.crlValidityDays && reissue >= validity * 24) {
      errors.crlReissueHours = `ต้องน้อยกว่าอายุ CRL (${validity * 24} ชั่วโมง) เพื่อให้ออกฉบับใหม่ก่อนฉบับเดิมหมดอายุ`;
    }
    if (!reason.trim()) errors.reason = 'กรุณาระบุเหตุผล';
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
      await apiMutate('/admin/system-settings', 'PUT', {
        allowedEmailDomains: parseDomains(domains),
        sessionTtlDays: Number(values.sessionTtlDays),
        crlValidityDays: Number(values.crlValidityDays),
        crlReissueHours: Number(values.crlReissueHours),
        reason: reason.trim(),
      });
      setReason('');
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">บันทึกค่าตั้งแล้ว มีผลทันที</Alert>}

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">การเข้าสู่ระบบ</h2>
          <p className="mt-1 text-sm text-muted">มีผลกับการเข้าสู่ระบบครั้งถัดไป ผู้ที่เข้าระบบอยู่แล้วไม่ได้รับผลกระทบ</p>
        </div>
        <TextField
          name="allowedEmailDomains"
          label="โดเมนที่ไม่ต้องรออนุมัติ"
          value={domains}
          onChange={(e) => {
            setSaved(false);
            setDomains(e.target.value);
          }}
          hint="คั่นด้วยจุลภาค — บัญชีโดเมนนี้เป็นนิสิต/บุคลากรใช้งานได้ทันที (ตรวจ claim hd ด้วย) โดเมนอื่นเป็นบุคลากรภายนอกรออนุมัติ"
          error={fieldErrors.allowedEmailDomains}
          autoCapitalize="off"
          spellCheck={false}
        />
        <TextField
          name="sessionTtlDays"
          label="อายุการเข้าสู่ระบบ (วัน)"
          type="number"
          inputMode="numeric"
          min={1}
          max={30}
          value={values.sessionTtlDays}
          onChange={set('sessionTtlDays')}
          hint="เข้าระบบแล้วใช้งานได้กี่วันก่อนต้องเข้าระบบใหม่"
          error={fieldErrors.sessionTtlDays}
        />
      </section>

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">รายการเพิกถอนใบรับรอง (CRL)</h2>
          <p className="mt-1 text-sm text-muted">
            ระบบออก CRL ใหม่ทันทีเมื่อมีการเพิกถอน และตามรอบด้านล่างแม้ไม่มีการเพิกถอน มีผลกับฉบับที่ออกหลังบันทึก
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="crlValidityDays"
            label="อายุ CRL (วัน)"
            type="number"
            inputMode="numeric"
            min={1}
            max={30}
            value={values.crlValidityDays}
            onChange={set('crlValidityDays')}
            hint="ผู้ตรวจลายเซ็นใช้ฉบับที่เก็บไว้ได้จนครบอายุ สั้น = การเพิกถอนมีผลเร็วขึ้น"
            error={fieldErrors.crlValidityDays}
          />
          <TextField
            name="crlReissueHours"
            label="ออกฉบับใหม่ทุก (ชั่วโมง)"
            type="number"
            inputMode="numeric"
            min={1}
            max={168}
            value={values.crlReissueHours}
            onChange={set('crlReissueHours')}
            hint="ต้องน้อยกว่าอายุ CRL มาก เผื่อบริการเซ็นขัดข้อง"
            error={fieldErrors.crlReissueHours}
          />
        </div>
      </section>

      <section className="space-y-1.5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <label htmlFor="field-reason" className="block text-sm font-medium">
          เหตุผลที่แก้
        </label>
        <textarea
          id="field-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          aria-invalid={fieldErrors.reason ? true : undefined}
          className={`block w-full rounded-lg border bg-surface px-3 py-2 text-base ${fieldErrors.reason ? 'border-danger' : 'border-line-input'}`}
        />
        {fieldErrors.reason ? (
          <p className="flex items-start gap-1.5 text-sm text-danger-fg">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {fieldErrors.reason}
          </p>
        ) : (
          <p className="text-sm text-muted">บันทึกไว้ในประวัติพร้อมค่าก่อนและหลังแก้ แก้หรือลบไม่ได้</p>
        )}
      </section>

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" fullWidth loading={submitting}>
          บันทึกค่าตั้ง
        </Button>
      </div>
    </form>
  );
}
