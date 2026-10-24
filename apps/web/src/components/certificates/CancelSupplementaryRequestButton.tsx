'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

/** ผู้ขอยกเลิกคำขอ (ใบเสริม / ใบประจำตัว) ที่ยังไม่ได้รับใบ — ย้อนกลับไม่ได้ ต้องส่งคำขอใหม่ */
export function CancelSupplementaryRequestButton({
  requestId,
  basePath = '/me/supplementary-certificate-requests',
}: {
  requestId: string;
  /** API ของคำขอประเภทนั้น */
  basePath?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="secondary" size="sm" fullWidth onClick={() => setOpen(true)}>
        <X className="size-4" aria-hidden />
        ยกเลิกคำขอ
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="ยกเลิกคำขอนี้หรือไม่?"
        description="ยกเลิกแล้วรับใบรับรองจากคำขอนี้ไม่ได้ ถ้ายังต้องการใช้ต้องส่งคำขอใหม่และรออนุมัติอีกครั้ง"
        confirmLabel="ยกเลิกคำขอ"
        tone="danger"
        onConfirm={async () => {
          await apiMutate(`${basePath}/${requestId}/cancel`, 'POST');
          router.refresh();
        }}
      />
    </>
  );
}
