import type { Metadata } from 'next';
import Link from 'next/link';
import { ShieldX } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';

export const metadata: Metadata = { title: 'ไม่มีสิทธิ์เข้าถึง' };

// หน้า "ไม่มีสิทธิ์เข้าถึง" — ใช้เมื่อ API ตอบ 403 (การตรวจสิทธิ์จริงอยู่ที่ API เสมอ)
export default function ForbiddenPage() {
  return (
    <PageShell width="form">
      <StatusState
        icon={ShieldX}
        tone="warning"
        headingLevel="h1"
        title="ไม่มีสิทธิ์เข้าถึง"
        action={
          <Link href="/" className={buttonClasses({ fullWidth: true })}>
            กลับหน้าหลัก
          </Link>
        }
      >
        บัญชีของคุณไม่มีสิทธิ์ใช้งานหน้านี้ หากคิดว่าเป็นความผิดพลาด กรุณาติดต่อผู้ดูแลระบบ
      </StatusState>
    </PageShell>
  );
}
