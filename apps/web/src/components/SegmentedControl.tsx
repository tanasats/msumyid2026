'use client';

import type { LucideIcon } from 'lucide-react';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** เนื้อหาที่แสดงแทนป้าย (เช่น "ก" ขนาดต่าง ๆ) — label ยังใช้เป็นชื่อสำหรับโปรแกรมอ่านหน้าจอ */
  display?: React.ReactNode;
};

/**
 * ตัวเลือกแบบแท็บแคปซูล (เลือกได้ 1 ค่า) สำหรับการตั้งค่าการแสดงผล
 * ปุ่มสูง ≥ 44px ใช้ aria-pressed บอกค่าที่เลือก
 * compact = แสดงเฉพาะไอคอน (ป้ายอยู่ใน aria-label/title)
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  compact = false,
}: {
  /** ชื่อกลุ่มสำหรับโปรแกรมอ่านหน้าจอ */
  label: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex rounded-full border border-line bg-canvas p-1 ${compact ? '' : 'w-full sm:w-auto'}`}
    >
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon, display }) => {
        const selected = value === optionValue;
        const iconOnly = compact && Icon;
        return (
          <button
            key={optionValue}
            type="button"
            onClick={() => onChange(optionValue)}
            aria-pressed={selected}
            aria-label={iconOnly || display ? optionLabel : undefined}
            title={iconOnly || display ? optionLabel : undefined}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-full text-sm font-medium transition ${
              compact ? 'min-w-11' : 'flex-1 px-4 sm:flex-none'
            } ${
              selected ? 'bg-surface text-accent-soft-fg shadow-card ring-1 ring-gold/60' : 'text-muted hover:text-fg'
            }`}
          >
            {Icon && <Icon className="size-4" aria-hidden />}
            {display ? <span aria-hidden>{display}</span> : !iconOnly && optionLabel}
          </button>
        );
      })}
    </div>
  );
}
