import Link from 'next/link';
import { PageShell } from '@/components/PageShell';

// หน้า "ไม่มีสิทธิ์เข้าถึง" — ใช้เมื่อ API ตอบ 403 (การตรวจสิทธิ์จริงอยู่ที่ API เสมอ)
export default function ForbiddenPage() {
  return (
    <PageShell>
      <section className="rounded-xl border border-amber-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-amber-700">ไม่มีสิทธิ์เข้าถึง</h1>
        <p className="mt-2 text-slate-600">บัญชีของคุณไม่มีสิทธิ์ใช้งานหน้านี้ หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ</p>
        <Link href="/" className="mt-4 inline-block text-sm text-blue-700 underline">
          กลับหน้าแรก
        </Link>
      </section>
    </PageShell>
  );
}
