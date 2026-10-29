'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';
import { SELF_REVOCATION_REASONS, type RevocationReasonOption } from '@/lib/certificate';
import { URGENT_REVOCATION_REASONS } from '@/lib/certificate-revocation-request';

/**
 * ปุ่มเพิกถอนใบรับรอง + กล่องยืนยันพร้อมเลือกเหตุผล (ย้อนกลับไม่ได้)
 * ผู้ดูแล (requireNote) ต้องกรอกบันทึกประกอบซึ่งเก็บใน audit log
 * requestEndpoint (ใบประจำตัวของตัวเอง): เหตุผลที่ไม่เร่งด่วนส่งเป็นคำขอเพิกถอนรออนุมัติแทน (API ตรวจกฎอีกครั้ง)
 */
export function RevokeCertificateButton({
  endpoint,
  serialNumber,
  reasons = SELF_REVOCATION_REASONS,
  requireNote = false,
  requestEndpoint,
}: {
  /** API สำหรับเพิกถอน เช่น /me/certificates/:id/revoke */
  endpoint: string;
  serialNumber: string;
  reasons?: RevocationReasonOption[];
  requireNote?: boolean;
  /** API ส่งคำขอเพิกถอน เช่น /me/certificates/:id/revocation-requests — ไม่ระบุ = เพิกถอนทันทีทุกเหตุผล */
  requestEndpoint?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  // เหตุผลที่เลือกต้องรออนุมัติ — ยังไม่เลือกถือว่าเพิกถอนทันที (ข้อความเตือนแบบเข้มไว้ก่อน)
  const asRequest = Boolean(requestEndpoint) && reason !== null && !URGENT_REVOCATION_REASONS.includes(reason);

  function openDialog() {
    setReason(null);
    setOpen(true);
  }

  async function handleConfirm(note: string) {
    if (!reason) throw new Error('กรุณาเลือกเหตุผลที่เพิกถอน');
    if (asRequest) {
      await apiMutate(requestEndpoint!, 'POST', { reason });
    } else {
      await apiMutate(endpoint, 'POST', requireNote ? { reason, note } : { reason });
    }
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
        title={asRequest ? 'ส่งคำขอเพิกถอนใบรับรองนี้หรือไม่?' : 'เพิกถอนใบรับรองนี้หรือไม่?'}
        description={
          asRequest ? (
            <>
              ใบรับรองหมายเลข <span className="font-mono text-xs break-all">{serialNumber}</span>{' '}
              ยังใช้งานได้จนกว่าผู้ดูแลจะอนุมัติ เมื่ออนุมัติแล้วจะยกเลิกการเพิกถอนไม่ได้ ระหว่างรอยกเลิกคำขอได้
            </>
          ) : (
            <>
              ใบรับรองหมายเลข <span className="font-mono text-xs break-all">{serialNumber}</span>{' '}
              จะใช้งานไม่ได้ทันทีและยกเลิกการเพิกถอนไม่ได้ ลายมือชื่อที่จะลงด้วยใบนี้ต่อจากนี้จะตรวจไม่ผ่าน
            </>
          )
        }
        confirmLabel={asRequest ? 'ส่งคำขอเพิกถอน' : 'เพิกถอนใบรับรอง'}
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
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
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
                {requestEndpoint && !URGENT_REVOCATION_REASONS.includes(r.value) && (
                  <span className="block text-muted">ต้องรอผู้ดูแลอนุมัติ</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      </ConfirmDialog>
    </>
  );
}
