'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';
import { validateRange, type SupplementaryLimits, type SupplementaryRequest } from '@/lib/supplementary-certificate';
import { DateRangeFields, type DateRangeErrors } from './DateRangeFields';

/**
 * ปุ่มอนุมัติ/ปฏิเสธคำขอใบเสริม (ต้องมี certificate:approve — API ตรวจสิทธิ์และกฎ canManageUser อีกครั้ง)
 * อนุมัติ: ช่วงวันที่เริ่มจากที่ผู้ขอขอ แก้ได้ภายในเพดาน / ปฏิเสธ: ต้องระบุเหตุผล (ผู้ขอเห็น)
 */
export function SupplementaryDecisionButtons({
  request,
  requesterName,
  limits,
}: {
  request: Pick<SupplementaryRequest, 'id' | 'requestedStart' | 'requestedEnd'>;
  requesterName: string;
  limits: Pick<SupplementaryLimits, 'maxDays' | 'maxLeadDays' | 'today'>;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [range, setRange] = useState({ startDate: request.requestedStart, endDate: request.requestedEnd });
  const [rangeErrors, setRangeErrors] = useState<DateRangeErrors>({});

  function openApprove() {
    setRange({ startDate: request.requestedStart, endDate: request.requestedEnd });
    setRangeErrors({});
    setDialog('approve');
  }

  async function handleApprove(note: string) {
    const error = validateRange(range, limits, 'approve');
    setRangeErrors(error ? { [error.field]: error.message } : {});
    if (error) throw new Error(error.message);
    await apiMutate(`/admin/supplementary-certificate-requests/${request.id}/approve`, 'POST', { ...range, note });
    router.refresh();
  }

  async function handleReject(note: string) {
    await apiMutate(`/admin/supplementary-certificate-requests/${request.id}/reject`, 'POST', { note });
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" fullWidth onClick={() => setDialog('reject')}>
        <X className="size-4" aria-hidden />
        ไม่อนุมัติ
      </Button>
      <Button size="sm" fullWidth onClick={openApprove}>
        <Check className="size-4" aria-hidden />
        อนุมัติ
      </Button>

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title="อนุมัติคำขอนี้หรือไม่?"
        description={`${requesterName} จะรับใบรับรองเสริมได้ตามช่วงวันที่ด้านล่าง แก้ช่วงได้ถ้าต้องการให้สั้นลงหรือเลื่อนวัน`}
        confirmLabel="อนุมัติคำขอ"
        reason="optional"
        reasonHint="ผู้ขอเห็นข้อความนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={handleApprove}
      >
        <DateRangeFields
          idPrefix={`approve-${request.id}-`}
          {...range}
          onChange={(next) => {
            setRange(next);
            setRangeErrors({});
          }}
          limits={limits}
          allowPastStart
          errors={rangeErrors}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        title="ไม่อนุมัติคำขอนี้หรือไม่?"
        description={`${requesterName} จะเห็นเหตุผลที่ระบุ และต้องส่งคำขอใหม่ถ้ายังต้องการใช้`}
        confirmLabel="ไม่อนุมัติคำขอ"
        tone="danger"
        reason="required"
        reasonHint="ผู้ขอเห็นเหตุผลนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={handleReject}
      />
    </>
  );
}
