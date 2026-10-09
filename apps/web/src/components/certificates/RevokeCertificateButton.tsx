'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';
import { SELF_REVOCATION_REASONS, type RevocationReasonOption } from '@/lib/certificate';

/**
 * ปุ่มเพิกถอนใบรับรอง + กล่องยืนยันพร้อมเลือกเหตุผล (ย้อนกลับไม่ได้)
 * ผู้ดูแล (requireNote) ต้องกรอกบันทึกประกอบซึ่งเก็บใน audit log
 */
export function RevokeCertificateButton({
  endpoint,
  serialNumber,
  reasons = SELF_REVOCATION_REASONS,
  requireNote = false,
}: {
  /** API สำหรับเพิกถอน เช่น /me/certificates/:id/revoke */
  endpoint: string;
  serialNumber: string;
  reasons?: RevocationReasonOption[];
  requireNote?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  function openDialog() {
    setReason(null);
    setOpen(true);
  }

  async function handleConfirm(note: string) {
    if (!reason) throw new Error('กรุณาเลือกเหตุผลที่เพิกถอน');
    await apiMutate(endpoint, 'POST', requireNote ? { reason, note } : { reason });
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" size="sm" fullWidth onClick={openDialog}>
        <Ban className="size-4" aria-hidden />
        เพิกถอน
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="เพิกถอนใบรับรองนี้หรือไม่?"
        description={
          <>
            ใบรับรองหมายเลข <span className="font-mono text-xs break-all">{serialNumber}</span>{' '}
            จะใช้งานไม่ได้ทันทีและยกเลิกการเพิกถอนไม่ได้ ลายมือชื่อที่จะลงด้วยใบนี้ต่อจากนี้จะตรวจไม่ผ่าน
          </>
        }
        confirmLabel="เพิกถอนใบรับรอง"
        tone="danger"
        reason={requireNote ? 'required' : undefined}
        reasonHint="บันทึกไว้ในประวัติของใบรับรองนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={handleConfirm}
      >
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">เหตุผลที่เพิกถอน</legend>
          {reasons.map((r) => (
            <label
              key={r.value}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
            >
              <input
                type="radio"
                name="revocation-reason"
                value={r.value}
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <span className="text-sm">
                <span className="block font-medium">{r.label}</span>
                {r.hint && <span className="block text-muted">{r.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      </ConfirmDialog>
    </>
  );
}
