'use client';

import { CircleAlert, RefreshCw } from 'lucide-react';
import { Button } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { StatusState } from '@/components/StatusState';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageShell width="form">
      <StatusState
        icon={CircleAlert}
        tone="danger"
        headingLevel="h1"
        title="เกิดข้อผิดพลาด"
        action={
          <Button fullWidth onClick={reset}>
            <RefreshCw className="size-5" aria-hidden />
            ลองใหม่
          </Button>
        }
      >
        ไม่สามารถแสดงหน้านี้ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง
      </StatusState>
    </PageShell>
  );
}
