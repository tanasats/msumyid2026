import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Clock, ShieldX } from 'lucide-react';
import { LogoutButton } from '@/components/LogoutButton';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'รอการอนุมัติ' };

// หน้าสำหรับบัญชีบุคลากรภายนอก/บัญชีหน่วยงานที่ยังไม่ได้รับอนุมัติ หรือถูกปฏิเสธ
export default async function PendingPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus === 'approved') redirect('/');

  const rejected = user.approvalStatus === 'rejected';

  return (
    <PageShell user={user} width="form">
      <StatusState
        icon={rejected ? ShieldX : Clock}
        tone={rejected ? 'danger' : 'warning'}
        headingLevel="h1"
        title={rejected ? 'บัญชีของคุณไม่ได้รับการอนุมัติ' : 'บัญชีของคุณอยู่ระหว่างรอการอนุมัติ'}
        action={<LogoutButton />}
      >
        <p>
          {rejected
            ? 'หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ'
            : user.accountType === 'service'
              ? 'บัญชีนี้ไม่พบในระบบบุคลากร (ERP) จึงถือเป็นบัญชีหน่วยงาน ผู้ดูแลระบบจะกำหนดหน่วยงานและผู้รับผิดชอบ แล้วจึงอนุมัติ หากเป็นบัญชีส่วนตัวของบุคลากร กรุณาติดต่อผู้ดูแลระบบ'
              : 'ผู้ดูแลระบบจะตรวจสอบบัญชีของคุณ เมื่อได้รับอนุมัติแล้วจึงจะใช้งานระบบได้'}
        </p>
        <p className="mt-3 text-sm break-all">บัญชี: {user.email}</p>
      </StatusState>
    </PageShell>
  );
}
