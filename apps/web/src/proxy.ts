import { NextResponse, type NextRequest } from 'next/server';
import { serverConfig } from '@/lib/config';

// หน้าที่เปิดได้โดยไม่ต้อง login
// / = หน้าแลนดิ้ง (ยังไม่ login) หรือหน้าหลัก (login แล้ว — หน้าเลือกเอง)
// /root-ca = วิธีติดตั้งใบรับรอง root สำหรับตรวจลายเซ็น, /verify = ตรวจลายมือชื่อบนเอกสาร (ผู้รับเอกสารอาจไม่มีบัญชีในระบบ)
const PUBLIC_PATHS = ['/', '/login', '/root-ca', '/root-ca/tuc-root-ca.cer', '/verify'];

/**
 * ผู้ที่ไม่มี session cookie → ส่งไปหน้า login (เพื่อ UX เท่านั้น — CLAUDE.md หัวข้อ 14)
 * ตรวจแค่ว่ามี cookie หรือไม่ (ไม่เรียก API) cookie ที่หมดอายุแล้วจะถูกจับโดยหน้าแต่ละหน้า
 * การตรวจสิทธิ์จริงอยู่ที่ API เสมอ
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  if (!request.cookies.has(serverConfig.sessionCookieName)) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // ไม่ต้องรันกับไฟล์ static และรูปภาพ
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)'],
};
