// โหมดการแสดงผล (สว่าง/มืด) — ใช้ได้ทั้ง Server และ Client Component
// เก็บใน cookie เพื่อให้ layout ใส่ data-theme ที่ <html> ได้ตั้งแต่ render ฝั่ง server (ไม่กระพริบตอนโหลด)
// เป็นค่าการแสดงผลของ browser เท่านั้น ไม่ใช่ข้อมูลส่วนบุคคลและไม่ส่งไป API

/** ชื่อ cookie เฉพาะโปรเจกต์ (cookie บน localhost ใช้ร่วมกันทุก port) */
export const THEME_COOKIE_NAME = 'msumyid_theme';

/** system = ตามการตั้งค่าของเครื่อง (ค่าเริ่มต้น) */
export type ThemePreference = 'system' | 'light' | 'dark';

export function parseThemePreference(value: string | undefined): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** ชื่อ cookie ขนาดตัวอักษร */
export const TEXT_SIZE_COOKIE_NAME = 'msumyid_text_size';

/** ขนาดตัวอักษร 4 ระดับ (ปรับขนาดฐานของ <html> — ทั้งเว็บใช้ rem จึงขยายตามกันทั้งหน้า) */
export type TextSize = 'small' | 'normal' | 'large' | 'xlarge';

export function parseTextSize(value: string | undefined): TextSize {
  return value === 'small' || value === 'large' || value === 'xlarge' ? value : 'normal';
}
