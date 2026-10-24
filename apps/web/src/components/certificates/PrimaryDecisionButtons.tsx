'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

/**
 * อนุมัติ/ปฏิเสธคำขอใบรับรองประจำตัว (ต้องมี certificate:approve — API ตรวจสิทธิ์และกฎ canManageUser อีกครั้ง)
 * อนุมัติ: บันทึกถึงผู้ขอไม่บังคับ / ปฏิเสธ: ต้องระบุเหตุผล (ผู้ขอเห็น)
 */
export function PrimaryDecisionButtons({ requestId, requesterName }: { requestId: string; requesterName: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);

  async function decide(decision: 'approve' | 'reject', note: string) {
    await apiMutate(`/admin/primary-certificate-requests/${requestId}/${decision}`, 'POST', note ? { note } : {});
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" fullWidth onClick={() => setDialog('reject')}>
        <X className="size-4" aria-hidden />
        ไม่อนุมัติ
      </Button>
      <Button size="sm" fullWidth onClick={() => setDialog('approve')}>
        <Check className="size-4" aria-hidden />
        อนุมัติ
      </Button>

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title="อนุมัติคำขอนี้หรือไม่?"
        description={`${requesterName} จะรับใบรับรองประจำตัวได้ภายใน 30 วัน (อายุใบตามนโยบาย)`}
        confirmLabel="อนุมัติคำขอ"
        reason="optional"
        reasonHint="ผู้ขอเห็นข้อความนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={(note) => decide('approve', note)}
      />
      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title="ไม่อนุมัติคำขอนี้หรือไม่?"
        description={`${requesterName} จะเห็นเหตุผลที่ระบุ และต้องส่งคำขอใหม่ถ้ายังต้องการใบรับรอง`}
        confirmLabel="ไม่อนุมัติคำขอ"
        tone="danger"
        reason="required"
        reasonHint="ผู้ขอเห็นเหตุผลนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={(note) => decide('reject', note)}
      />
    </>
  );
}
