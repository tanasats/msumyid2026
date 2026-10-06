import type { Metadata } from 'next';
import { Noto_Sans_Thai } from 'next/font/google';
import './globals.css';

const notoSansThai = Noto_Sans_Thai({
  subsets: ['thai', 'latin'],
  variable: '--font-noto-sans-thai',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ระบบบริหารจัดการใบรับรองดิจิทัล | มหาวิทยาลัยมหาสารคาม',
  description: 'ระบบบริการใบรับรองดิจิทัลแบบครบวงจร มหาวิทยาลัยมหาสารคาม',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={notoSansThai.variable}>
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
