import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'รอการอนุมัติ' };

// หน้าสำหรับบัญชีบุคลากรภายนอกที่ยังไม่ได้รับอนุมัติ หรือถูกปฏิเสธ
export default async function PendingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus === 'approved') redirect('/');

  const rejected = user.approvalStatus === 'rejected';

  return (
    <PageShell user={user}>
      <section
        className={`mx-auto max-w-lg rounded-xl border bg-white p-6 text-center ${
          rejected ? 'border-red-200' : 'border-amber-200'
        }`}
      >
        <h1 className={`text-lg font-semibold ${rejected ? 'text-red-700' : 'text-amber-700'}`}>
          {rejected ? 'บัญชีของคุณไม่ได้รับการอนุมัติ' : 'บัญชีของคุณอยู่ระหว่างรอการอนุมัติ'}
        </h1>
        <p className="mt-2 text-slate-600">
          {rejected
            ? 'หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ'
            : 'ผู้ดูแลระบบจะตรวจสอบบัญชีของคุณ เมื่อได้รับอนุมัติแล้วจึงจะใช้งานระบบได้'}
        </p>
        <p className="mt-4 text-sm text-slate-500">บัญชี: {user.email}</p>
      </section>
    </PageShell>
  );
}
