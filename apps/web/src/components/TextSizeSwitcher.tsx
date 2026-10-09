'use client';

import { useState } from 'react';
import { TEXT_SIZE_COOKIE_NAME, type TextSize } from '@/lib/theme';
import { setPreferenceCookie } from '@/lib/display-preference-client';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl';

// แสดง "ก" ขนาดต่างกันให้เห็นผลก่อนเลือก (ขนาดคงที่เป็น px ไม่ขยายตามตัวเลือกเอง)
const OPTIONS: SegmentedOption<TextSize>[] = [
  { value: 'small', label: 'เล็ก', display: <span className="text-[13px]">ก เล็ก</span> },
  { value: 'normal', label: 'ปกติ', display: <span className="text-[15px]">ก ปกติ</span> },
  { value: 'large', label: 'ใหญ่', display: <span className="text-[17px]">ก ใหญ่</span> },
  { value: 'xlarge', label: 'ใหญ่มาก', display: <span className="text-[19px]">ก ใหญ่มาก</span> },
];

/** เลือกขนาดตัวอักษร 4 ระดับ — บันทึกใน cookie และเปลี่ยนหน้าปัจจุบันทันที */
export function TextSizeSwitcher({ initial }: { initial: TextSize }) {
  const [size, setSize] = useState(initial);
  return (
    <SegmentedControl
      label="ขนาดตัวอักษร"
      options={OPTIONS}
      value={size}
      onChange={(value) => {
        setSize(value);
        setPreferenceCookie(TEXT_SIZE_COOKIE_NAME, value);
        if (value === 'normal') delete document.documentElement.dataset.textSize;
        else document.documentElement.dataset.textSize = value;
      }}
    />
  );
}
