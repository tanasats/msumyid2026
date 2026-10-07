import Link from 'next/link';
import { SearchX } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';

export default function NotFound() {
  return (
    <PageShell width="form">
      <StatusState
        icon={SearchX}
        headingLevel="h1"
        title="ไม่พบหน้าที่ต้องการ"
        action={
          <Link href="/" className={buttonClasses({ fullWidth: true })}>
            กลับหน้าหลัก
          </Link>
        }
      >
        ลิงก์อาจไม่ถูกต้อง หรือหน้านี้ถูกย้ายไปแล้ว
      </StatusState>
    </PageShell>
  );
}
