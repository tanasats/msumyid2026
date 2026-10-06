'use client';

import { PageShell } from '@/components/PageShell';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell>
      <section className="rounded-xl border border-red-200 bg-white p-6 text-center">
        <h1 className="text-lg font-semibold text-red-700">เกิดข้อผิดพลาด</h1>
        <p className="mt-2 text-slate-600">ไม่สามารถแสดงหน้านี้ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง</p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700"
        >
          ลองใหม่
        </button>
      </section>
    </PageShell>
  );
}
