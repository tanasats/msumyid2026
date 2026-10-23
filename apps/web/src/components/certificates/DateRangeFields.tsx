'use client';

import { TextField } from '@/components/TextField';
import { addDays, formatRange, type SupplementaryLimits } from '@/lib/supplementary-certificate';

export type DateRangeErrors = Partial<Record<'startDate' | 'endDate', string>>;

/**
 * ช่องวันเริ่ม/วันสิ้นสุด (ปฏิทินของ browser) + สรุปจำนวนวัน — ใช้ทั้งฟอร์มขอและกล่องอนุมัติ
 * min/max ช่วยจำกัดในปฏิทินเท่านั้น ผู้เรียกตรวจค่าด้วย validateRange และ API ตรวจอีกครั้ง
 */
export function DateRangeFields({
  idPrefix,
  startDate,
  endDate,
  onChange,
  onBlur,
  limits,
  allowPastStart = false,
  errors = {},
}: {
  /** ใช้สร้าง id ของช่องให้ไม่ซ้ำกันในหน้าเดียว */
  idPrefix: string;
  startDate: string;
  endDate: string;
  onChange: (range: { startDate: string; endDate: string }) => void;
  onBlur?: () => void;
  limits: Pick<SupplementaryLimits, 'maxDays' | 'maxLeadDays' | 'today'>;
  /** ผู้อนุมัติ: คำขอที่รออนุมัติข้ามวันเริ่มไปแล้วยังอนุมัติได้ */
  allowPastStart?: boolean;
  errors?: DateRangeErrors;
}) {
  const latestStart = addDays(limits.today, limits.maxLeadDays);
  return (
    <div className="space-y-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name={`${idPrefix}StartDate`}
          label="วันเริ่ม"
          type="date"
          value={startDate}
          min={allowPastStart ? undefined : limits.today}
          max={latestStart}
          onChange={(e) => onChange({ startDate: e.target.value, endDate })}
          onBlur={onBlur}
          error={errors.startDate}
        />
        <TextField
          name={`${idPrefix}EndDate`}
          label="วันสิ้นสุด"
          type="date"
          value={endDate}
          min={startDate || limits.today}
          max={startDate ? addDays(startDate, limits.maxDays - 1) : undefined}
          onChange={(e) => onChange({ startDate, endDate: e.target.value })}
          onBlur={onBlur}
          error={errors.endDate}
        />
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {startDate && endDate && endDate >= startDate
          ? `ใช้ได้ ${formatRange(startDate, endDate)} ตั้งแต่ 00:00 น. ถึง 23:59 น.`
          : `ยาวได้ไม่เกิน ${limits.maxDays} วัน และเริ่มล่วงหน้าได้ไม่เกิน ${limits.maxLeadDays} วัน`}
      </p>
    </div>
  );
}
