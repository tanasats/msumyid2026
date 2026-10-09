import type { Metadata, Viewport } from 'next';
import { Sarabun } from 'next/font/google';
import { getTextSize, getThemePreference } from '@/lib/theme-server';
import './globals.css';

// ฟอนต์เดียวทั้งระบบ (เนื้อหาและหัวข้อ) — Sarabun ไม่ใช่ variable font จึงต้องระบุน้ำหนักที่ใช้ (400 ปกติ, 500 medium, 600 semibold, 700 ตัวหนาเริ่มต้นเช่น <th>)
const sarabun = Sarabun({
  weight: ['400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
  variable: '--font-sarabun',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'MSU Digital ID | มหาวิทยาลัยมหาสารคาม',
    template: '%s | MSU Digital ID',
  },
  description: 'ระบบบริการใบรับรองดิจิทัลแบบครบวงจร มหาวิทยาลัยมหาสารคาม',
};

// viewportFit: cover ให้ใช้พื้นที่ถึงขอบจอ (notch/home indicator) แล้วเว้นด้วย env(safe-area-inset-*)
// ห้ามปิดการซูม (maximumScale/userScalable) — ผู้ใช้ต้องขยายตัวอักษรได้
// themeColor = สีแถบ browser บนมือถือ ตามโหมดของเครื่อง (สีเดียวกับ surface ใน globals.css)
export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fffdf9' },
    { media: '(prefers-color-scheme: dark)', color: '#16130f' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // ผู้ใช้เลือกโหมดเอง → ใส่ data-theme ตั้งแต่ฝั่ง server, "ตามระบบ" → ไม่ใส่ ให้ prefers-color-scheme ตัดสิน
  const [theme, textSize] = await Promise.all([getThemePreference(), getTextSize()]);
  return (
    <html
      lang="th"
      className={sarabun.variable}
      data-theme={theme === 'system' ? undefined : theme}
      data-text-size={textSize === 'normal' ? undefined : textSize}
    >
      <body className="min-h-dvh bg-canvas font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
