import { cookies } from 'next/headers';
import {
  TEXT_SIZE_COOKIE_NAME,
  THEME_COOKIE_NAME,
  parseTextSize,
  parseThemePreference,
  type TextSize,
  type ThemePreference,
} from './theme';

/** โหมดการแสดงผลที่ผู้ใช้เลือก (อ่านจาก cookie) — ใช้ได้เฉพาะ Server Component */
export async function getThemePreference(): Promise<ThemePreference> {
  return parseThemePreference((await cookies()).get(THEME_COOKIE_NAME)?.value);
}

/** ขนาดตัวอักษรที่ผู้ใช้เลือก (อ่านจาก cookie) — ใช้ได้เฉพาะ Server Component */
export async function getTextSize(): Promise<TextSize> {
  return parseTextSize((await cookies()).get(TEXT_SIZE_COOKIE_NAME)?.value);
}
