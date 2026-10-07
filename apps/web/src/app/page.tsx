import { redirect } from 'next/navigation';
import { PageShell } from '@/components/PageShell';
import { ACCOUNT_TYPE_LABELS, getCurrentUser } from '@/lib/auth';

// หน้าแรกหลัง login (ชั่วคราว: แสดงข้อมูลบัญชี จะแทนด้วยหน้าหลักของระบบในขั้นถัดไป)
export default async function HomePage() {
  const user = await getCurrentUser();
  // cookie หมดอายุ/ถูกเพิกถอน (proxy ตรวจแค่ว่ามี cookie)
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  return (
    <PageShell user={user}>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">ยินดีต้อนรับ {user.name}</h1>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-slate-500">อีเมล</dt>
          <dd className="break-all">{user.email}</dd>
          <dt className="text-slate-500">ประเภทบัญชี</dt>
          <dd>{ACCOUNT_TYPE_LABELS[user.accountType]}</dd>
          <dt className="text-slate-500">บทบาท</dt>
          <dd className="flex flex-wrap gap-2">
            {user.roles.map((role) => (
              <span key={role} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs">
                {role}
              </span>
            ))}
          </dd>
        </dl>
      </section>
    </PageShell>
  );
}
