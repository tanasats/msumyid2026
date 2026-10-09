'use client';

import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_COOKIE_NAME, type ThemePreference } from '@/lib/theme';
import { setPreferenceCookie } from '@/lib/display-preference-client';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl';

const OPTIONS: SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'ตามระบบ', icon: Monitor },
  { value: 'light', label: 'สว่าง', icon: Sun },
  { value: 'dark', label: 'มืด', icon: Moon },
];

/** บันทึกโหมดใน cookie (ให้ server render ถูกโหมดตั้งแต่หน้าแรก) และเปลี่ยนหน้าปัจจุบันทันที */
function applyTheme(theme: ThemePreference) {
  setPreferenceCookie(THEME_COOKIE_NAME, theme);
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

/**
 * เลือกโหมดการแสดงผล: ตามระบบ / สว่าง / มืด
 * compact = ปุ่มไอคอนอย่างเดียว สำหรับ header ของหน้าที่ยังเข้าหน้า "บัญชีของฉัน" ไม่ได้ (login / รออนุมัติ)
 */
export function ThemeSwitcher({ initial, compact = false }: { initial: ThemePreference; compact?: boolean }) {
  const [theme, setTheme] = useState(initial);
  return (
    <SegmentedControl
      label="โหมดการแสดงผล"
      options={OPTIONS}
      value={theme}
      compact={compact}
      onChange={(value) => {
        setTheme(value);
        applyTheme(value);
      }}
    />
  );
}
