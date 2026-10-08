import { redirect } from 'next/navigation';
import { FileBadge } from 'lucide-react';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';

// หน้าแรกหลัง login (ชั่วคราว: ยังไม่มีบริการ จะแทนด้วยหน้าหลักของระบบเมื่อสร้างฟังก์ชันใบรับรอง)
export default async function HomePage() {
  const user = await getCurrentUser();
  // cookie หมดอายุ/ถูกเพิกถอน (proxy ตรวจแค่ว่ามี cookie)
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');

  return (
    <PageShell title="หน้าหลัก" user={user}>
      <div className="space-y-6">
        <section>
          <h2 className="text-xl font-semibold lg:text-2xl">สวัสดี {user.name}</h2>
          <p className="mt-1 text-muted">ยินดีต้อนรับสู่ MSU Digital ID</p>
        </section>

        <div className="rounded-xl border border-line bg-surface">
          <StatusState icon={FileBadge} title="ยังไม่มีบริการที่เปิดใช้งาน">
            บริการใบรับรองดิจิทัลจะแสดงที่นี่เมื่อเปิดให้บริการ
          </StatusState>
        </div>
      </div>
    </PageShell>
  );
}
