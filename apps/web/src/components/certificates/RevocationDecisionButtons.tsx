'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

/**
 * อนุมัติ/ปฏิเสธคำขอเพิกถอนใบรับรอง (ต้องมี certificate:revoke — API ตรวจสิทธิ์และกฎ canManageUser อีกครั้ง)
 * อนุมัติ = เพิกถอนใบทันที (บันทึกไม่บังคับ) / ปฏิเสธ: ต้องระบุเหตุผล (ผู้ขอเห็น)
 */
export function RevocationDecisionButtons({
  requestId,
  requesterName,
  serialNumber,
}: {
  requestId: string;
  requesterName: string;
  serialNumber: string;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);

  async function decide(decision: 'approve' | 'reject', note: string) {
    await apiMutate(`/admin/certificate-revocation-requests/${requestId}/${decision}`, 'POST', note ? { note } : {});
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" fullWidth onClick={() => setDialog('reject')}>
        <X className="size-4" aria-hidden />
        ไม่อนุมัติ
      </Button>
      <Button size="sm" fullWidth onClick={() => setDialog('approve')}>
        <Ban className="size-4" aria-hidden />
        อนุมัติและเพิกถอน
      </Button>

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title="อนุมัติและเพิกถอนใบรับรองนี้หรือไม่?"
        description={
          <>
            ใบรับรองหมายเลข <span className="font-mono text-xs break-all">{serialNumber}</span> ของ {requesterName}{' '}
            จะใช้งานไม่ได้ทันทีและยกเลิกการเพิกถอนไม่ได้
          </>
        }
        confirmLabel="อนุมัติและเพิกถอน"
        tone="danger"
        reason="optional"
        reasonHint="ผู้ขอเห็นข้อความนี้ และบันทึกในประวัติของใบรับรอง — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={(note) => decide('approve', note)}
      />
      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title="ไม่อนุมัติคำขอนี้หรือไม่?"
        description={`ใบรับรองของ ${requesterName} ใช้งานได้ต่อตามปกติ และผู้ขอจะเห็นเหตุผลที่ระบุ`}
        confirmLabel="ไม่อนุมัติคำขอ"
        reason="required"
        reasonHint="ผู้ขอเห็นเหตุผลนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={(note) => decide('reject', note)}
      />
    </>
  );
}
