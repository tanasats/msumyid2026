'use client';

import { todayDateInput } from '@/lib/account-type';

/** ช่องวันหมดอายุของบัญชีหน่วยงาน (ไม่บังคับ) — ค่าเป็น YYYY-MM-DD, '' = ไม่หมดอายุ */
export function AccountExpiryField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="field-accountExpiresAt" className="block text-sm font-medium text-fg">
        วันหมดอายุ <span className="font-normal text-muted">(ไม่บังคับ)</span>
      </label>
      <input
        id="field-accountExpiresAt"
        type="date"
        value={value}
        min={todayDateInput()}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby="field-accountExpiresAt-hint"
        className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base text-fg"
      />
      <p id="field-accountExpiresAt-hint" className="text-sm text-muted">
        ใช้กับบัญชีกิจกรรม — สิ้นวันที่เลือกระบบจะปิดบัญชีอัตโนมัติ เว้นว่าง = ไม่หมดอายุ
      </p>
    </div>
  );
}
