import type { Metadata, Viewport } from 'next';
import { Noto_Sans_Thai } from 'next/font/google';
import './globals.css';

const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  variable: '--font-noto-sans-thai',
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
export const viewport: Viewport = {
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={notoSansThai.variable}>
      <body className="min-h-dvh bg-canvas font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
