import Link from 'next/link';
import { PageShell } from '@/components/PageShell';

export default function NotFound() {
  return (
    <PageShell>
      <section className="rounded-xl border border-slate-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold">ไม่พบหน้าที่ต้องการ</h1>
        <Link href="/" className="mt-4 inline-block text-sm text-blue-700 underline">
          กลับหน้าแรก
        </Link>
      </section>
    </PageShell>
  );
}
