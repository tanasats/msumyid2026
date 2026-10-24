'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarDays, CalendarRange } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TextField } from '@/components/TextField';
import { apiMutate } from '@/lib/api-client';
import {
  MAX_DAY_OF_MONTH,
  THAI_MONTHS,
  previewPrimaryExpiry,
  type CertificatePolicySettings,
  type PrimaryValidityMode,
} from '@/lib/certificate-policy';

const selectClass = 'block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base';
const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' });

type NumberKey = Exclude<keyof CertificatePolicySettings, 'primaryMode'>;

/**
 * ฟอร์มนโยบายอายุใบรับรอง — แสดงตัวอย่างวันหมดอายุทันทีที่แก้ (API คำนวณจริงและตรวจค่าอีกครั้งตอนบันทึก)
 * มีผลกับใบที่ออกหลังบันทึกเท่านั้น ใบเดิมไม่เปลี่ยน
 */
export function CertificatePolicyForm({ initial }: { initial: CertificatePolicySettings }) {
  const router = useRouter();
  const [mode, setMode] = useState<PrimaryValidityMode>(initial.primaryMode);
  // เก็บเป็นข้อความระหว่างพิมพ์ (ช่องว่างได้) แล้วแปลงเป็นตัวเลขตอนคำนวณ/ส่ง
  const [values, setValues] = useState<Record<NumberKey, string>>(() => ({
    primaryDays: String(initial.primaryDays),
    primaryExpiryMonth: String(initial.primaryExpiryMonth),
    primaryExpiryDay: String(initial.primaryExpiryDay),
    primaryMinDays: String(initial.primaryMinDays),
    renewalWindowDays: String(initial.renewalWindowDays),
    supplementaryMaxDays: String(initial.supplementaryMaxDays),
    supplementaryMaxActive: String(initial.supplementaryMaxActive),
    supplementaryMaxLeadDays: String(initial.supplementaryMaxLeadDays),
  }));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const settings: CertificatePolicySettings = {
    primaryMode: mode,
    primaryDays: Number(values.primaryDays),
    primaryExpiryMonth: Number(values.primaryExpiryMonth),
    primaryExpiryDay: Number(values.primaryExpiryDay),
    primaryMinDays: Number(values.primaryMinDays),
    renewalWindowDays: Number(values.renewalWindowDays),
    supplementaryMaxDays: Number(values.supplementaryMaxDays),
    supplementaryMaxActive: Number(values.supplementaryMaxActive),
    supplementaryMaxLeadDays: Number(values.supplementaryMaxLeadDays),
  };
  const maxDay = MAX_DAY_OF_MONTH[settings.primaryExpiryMonth - 1] ?? 31;
  const dayInvalid = mode === 'fixed_date' && (settings.primaryExpiryDay < 1 || settings.primaryExpiryDay > maxDay);
  const preview = dayInvalid ? null : previewPrimaryExpiry(settings, new Date());

  const set = (key: NumberKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setSaved(false);
    setValues((v) => ({ ...v, [key]: event.target.value }));
  };

  const numberProps = (key: NumberKey) => ({
    name: key,
    type: 'number',
    inputMode: 'numeric' as const,
    min: 0,
    value: values[key],
    onChange: set(key),
  });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (Object.values(values).some((v) => v.trim() === '' || !Number.isInteger(Number(v)))) {
      setError('กรุณากรอกทุกช่องเป็นจำนวนเต็ม');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiMutate('/admin/certificate-policy', 'PUT', settings);
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
      {saved && <Alert tone="success">บันทึกนโยบายแล้ว มีผลกับใบรับรองที่ออกหลังจากนี้</Alert>}

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">ใบรับรองประจำตัว</h2>
          <p className="mt-1 text-sm text-muted">ผู้ใช้ขอเองได้คนละ 1 ใบ ใบที่ออกแล้วไม่เปลี่ยนตามนโยบายใหม่</p>
        </div>

        <SegmentedControl
          label="วิธีกำหนดอายุใบประจำตัว"
          value={mode}
          onChange={(m) => {
            setSaved(false);
            setMode(m);
          }}
          options={[
            { value: 'days', label: 'นับจำนวนวัน', icon: CalendarRange },
            { value: 'fixed_date', label: 'วันที่กำหนด', icon: CalendarDays },
          ]}
        />

        {mode === 'days' ? (
          <TextField
            {...numberProps('primaryDays')}
            label="อายุใบรับรอง (วัน)"
            max={825}
            hint="นับจากวันที่ออก เช่น 365 = 1 ปี (สูงสุด 825)"
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="field-primaryExpiryMonth" className="block text-sm font-medium">
                  เดือนที่หมดอายุ
                </label>
                <select
                  id="field-primaryExpiryMonth"
                  value={values.primaryExpiryMonth}
                  onChange={set('primaryExpiryMonth')}
                  className={selectClass}
                >
                  {THAI_MONTHS.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <TextField
                {...numberProps('primaryExpiryDay')}
                label="วันที่"
                min={1}
                max={maxDay}
                error={dayInvalid ? `เดือนนี้เลือกได้วันที่ 1–${maxDay}` : undefined}
              />
            </div>
            <TextField
              {...numberProps('primaryMinDays')}
              label="อายุขั้นต่ำ (วัน)"
              max={365}
              hint="ถ้าขอใกล้วันหมดอายุจนเหลือน้อยกว่านี้ ใบจะหมดอายุวันเดียวกันของปีถัดไป"
            />
          </>
        )}

        <TextField
          {...numberProps('renewalWindowDays')}
          label="ช่วงต่ออายุ (วัน)"
          max={365}
          hint="ผู้ใช้ขอใบประจำตัวใบใหม่ได้เมื่อใบเดิมเหลืออายุไม่เกินเท่านี้ ใบเดิมใช้ต่อได้จนหมดอายุ"
        />

        <div className="rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent-soft-fg" aria-live="polite">
          {preview ? (
            <>
              ถ้าขอวันนี้ ใบจะหมดอายุ <strong className="font-semibold">{dateFormatter.format(preview)}</strong>
            </>
          ) : (
            'กรอกค่าให้ครบเพื่อดูตัวอย่างวันหมดอายุ'
          )}
          <span className="mt-1 block text-xs opacity-80">ไม่เกินวันหมดอายุของใบรับรองหลักของมหาวิทยาลัย (CA)</span>
        </div>
      </section>

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">ใบรับรองเสริม</h2>
          <p className="mt-1 text-sm text-muted">
            ใบเฉพาะกิจหรือระยะสั้นสำหรับลงนามเอกสาร ผู้ใช้ส่งคำขอและรอผู้ดูแลอนุมัติ
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            {...numberProps('supplementaryMaxDays')}
            label="อายุสูงสุด (วัน)"
            min={1}
            max={825}
            hint="ทั้งที่ผู้ใช้ขอและที่ผู้อนุมัติกำหนด"
          />
          <TextField
            {...numberProps('supplementaryMaxActive')}
            label="ใช้งานพร้อมกันได้ต่อคน (ใบ)"
            max={20}
            hint="นับรวมคำขอที่รออนุมัติและยังไม่รับใบ — 0 = ปิดการขอใบเสริม"
          />
          <TextField
            {...numberProps('supplementaryMaxLeadDays')}
            label="วันเริ่มล่วงหน้าได้ไม่เกิน (วัน)"
            max={365}
            hint="นับจากวันที่ส่งคำขอ เช่น 90 = ขอใช้ในอีก 3 เดือนข้างหน้าได้"
          />
        </div>
      </section>

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" fullWidth loading={submitting}>
          บันทึกนโยบาย
        </Button>
      </div>
    </form>
  );
}
