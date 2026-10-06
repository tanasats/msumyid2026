import { PageShell } from '@/components/PageShell';
import { apiFetch } from '@/lib/api-server';

type Health = { status: 'ok' | 'error'; database: 'ok' | 'error' };

// หน้าแรกชั่วคราว: แสดงสถานะการเชื่อมต่อ API (จะแทนด้วยหน้า login/หน้าหลักในขั้นถัดไป)
export default async function HomePage() {
  let apiOnline: boolean;
  try {
    const health = await apiFetch<Health>('/health');
    apiOnline = health.status === 'ok';
  } catch {
    // API ตอบ 503 หรือติดต่อไม่ได้ → แสดงสถานะออฟไลน์ (API เป็นฝ่าย log สาเหตุ)
    apiOnline = false;
  }

  return (
    <PageShell>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">ยินดีต้อนรับ</h1>
        <p className="mt-2 text-slate-600">ระบบอยู่ระหว่างการพัฒนา</p>
        <p className="mt-4 flex items-center gap-2 text-sm">
          <span
            className={`inline-block size-2.5 rounded-full ${apiOnline ? 'bg-green-500' : 'bg-red-500'}`}
            aria-hidden
          />
          {apiOnline ? 'เชื่อมต่อระบบหลังบ้านได้' : 'ไม่สามารถเชื่อมต่อระบบหลังบ้านได้'}
        </p>
      </section>
    </PageShell>
  );
}
