'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

// เหตุผลที่ผู้ใช้เลือกได้ (ตรงกับ SELF_REVOCATION_REASONS ของ API)
const REASONS = [
  {
    value: 'keyCompromise',
    label: 'ไฟล์หรือรหัสผ่านอาจหลุดไปถึงผู้อื่น',
    hint: 'เช่น ทำเครื่องหรือไฟล์ .p12 หาย ส่งไฟล์ผิดคน',
  },
  { value: 'superseded', label: 'ได้ใบรับรองใหม่มาแทนแล้ว', hint: undefined },
  { value: 'affiliationChanged', label: 'ข้อมูลในใบรับรองไม่ถูกต้องแล้ว', hint: 'เช่น เปลี่ยนชื่อ ย้ายสังกัด' },
  { value: 'cessationOfOperation', label: 'ไม่ใช้งานใบรับรองนี้แล้ว', hint: undefined },
] as const;

type Reason = (typeof REASONS)[number]['value'];

/** ปุ่มเพิกถอนใบรับรองของตัวเอง + กล่องยืนยันพร้อมเลือกเหตุผล (ย้อนกลับไม่ได้) */
export function RevokeCertificateButton({ certificateId, serialNumber }: { certificateId: string; serialNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<Reason | null>(null);

  function openDialog() {
    setReason(null);
    setOpen(true);
  }

  async function handleConfirm() {
    if (!reason) throw new Error('กรุณาเลือกเหตุผลที่เพิกถอน');
    await apiMutate(`/me/certificates/${certificateId}/revoke`, 'POST', { reason });
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
        onConfirm={handleConfirm}
      >
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">เหตุผลที่เพิกถอน</legend>
          {REASONS.map((r) => (
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
