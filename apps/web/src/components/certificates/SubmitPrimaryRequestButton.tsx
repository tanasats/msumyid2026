'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

/** ส่งคำขอใบรับรองประจำตัว (certificate:apply) — วัตถุประสงค์ไม่บังคับ ผู้อนุมัติใช้พิจารณา */
export function SubmitPrimaryRequestButton({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button fullWidth onClick={() => setOpen(true)}>
        <FilePlus className="size-5" aria-hidden />
        ส่งคำขอใบรับรอง
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="ส่งคำขอใบรับรองประจำตัวหรือไม่?"
        description={
          <>
            ใบรับรองจะออกในชื่อ <span className="font-medium text-fg">{name}</span> อีเมล{' '}
            <span className="font-medium break-all text-fg">{email}</span> เมื่อได้รับอนุมัติ กด &quot;รับใบรับรอง&quot;
            ภายใน 30 วันเพื่อตั้งรหัสผ่านและดาวน์โหลดไฟล์
          </>
        }
        confirmLabel="ส่งคำขอ"
        reason="optional"
        reasonHint="บอกผู้อนุมัติว่าจะใช้ทำอะไร เช่น ลงนามรายงานฝึกงาน — ห้ามใส่ข้อมูลส่วนบุคคลของผู้อื่น"
        onConfirm={async (purpose) => {
          await apiMutate('/me/primary-certificate-requests', 'POST', purpose ? { purpose } : {});
          router.push('/certificates?applied=1');
          router.refresh();
        }}
      />
    </>
  );
}
