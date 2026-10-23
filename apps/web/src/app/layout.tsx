import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans_Thai_Looped } from 'next/font/google';
import localFont from 'next/font/local';
import { getTextSize, getThemePreference } from '@/lib/theme-server';
import './globals.css';

// ฟอนต์เนื้อหา — IBM Plex Sans Thai Looped: ไทยมีหัว (ทางการ) ออกแบบมาสำหรับหน้าจอ ละตินและตัวเลขสัดส่วนเข้ากับไทย
// ไม่ใช่ variable font จึงต้องระบุน้ำหนักที่ใช้ (400 ปกติ, 500 medium, 600 semibold, 700 ตัวหนาเริ่มต้นเช่น <th>)
const plexSansThai = IBM_Plex_Sans_Thai_Looped({
  weight: ['400', '500', '600', '700'],
  subsets: ['thai', 'latin'],
  variable: '--font-plex-sans-thai',
  display: 'swap',
});

// ฟอนต์รหัส (font-mono) — serial, fingerprint: แยก 0/O, 1/l ชัด และหน้าตาเหมือนกันทุกระบบปฏิบัติการ
const plexMono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-plex-mono',
  display: 'swap',
});

// ฟอนต์หัวข้อ (font-display) — Mornamchi ฟอนต์อัตลักษณ์ของมหาวิทยาลัยมหาสารคาม (ต้นฉบับ docs/Font - Mornamchi/)
// มีแค่ Regular/Bold สำหรับเว็บ: font-semibold (600) ที่หัวข้อใช้ → browser เลือก Bold (700) ให้เอง
// ไฟล์อยู่ใน repo (next/font/local) จึงไม่ต้องโหลดจากภายนอก
const mornamchi = localFont({
  src: [
    { path: '../fonts/Mornamchi-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/Mornamchi-Bold.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mornamchi',
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
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#121830' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // ผู้ใช้เลือกโหมดเอง → ใส่ data-theme ตั้งแต่ฝั่ง server, "ตามระบบ" → ไม่ใส่ ให้ prefers-color-scheme ตัดสิน
  const [theme, textSize] = await Promise.all([getThemePreference(), getTextSize()]);
  return (
    <html
      lang="th"
      className={`${plexSansThai.variable} ${mornamchi.variable} ${plexMono.variable}`}
      data-theme={theme === 'system' ? undefined : theme}
      data-text-size={textSize === 'normal' ? undefined : textSize}
    >
      <body className="min-h-dvh bg-canvas font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
