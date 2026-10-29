'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, Download } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';
import { SELF_REVOCATION_REASONS, type RevocationReasonOption } from '@/lib/certificate';
import { URGENT_REVOCATION_REASONS } from '@/lib/certificate-revocation-request';

// ตัวเลือก "ไม่ต้องเพิกถอน" (ไม่ใช่เหตุผลของ RFC 5280 — ไม่ส่งไป API)
const NO_REVOKE = 'noRevoke';

/**
 * ปุ่มเพิกถอนใบรับรอง + กล่องยืนยันพร้อมเลือกเหตุผล (ย้อนกลับไม่ได้)
 * ผู้ดูแล (requireNote) ต้องกรอกบันทึกประกอบซึ่งเก็บใน audit log
 * requestEndpoint (ใบประจำตัวของตัวเอง): เหตุผลที่ไม่เร่งด่วนส่งเป็นคำขอเพิกถอนรออนุมัติแทน (API ตรวจกฎอีกครั้ง)
 * downloadHref (ใบของตัวเอง): เพิ่มตัวเลือกแรก "ลืมรหัสผ่าน/เปลี่ยนเครื่อง" ซึ่งแนะนำให้ดาวน์โหลดใหม่แทนการเพิกถอน
 *   (ระยะ 9.4 — ผู้ใช้ใหม่มักเพิกถอนเพราะเข้าใจว่าเป็นทางเดียวที่จะได้ไฟล์ใหม่)
 */
export function RevokeCertificateButton({
  endpoint,
  serialNumber,
  reasons = SELF_REVOCATION_REASONS,
  requireNote = false,
  requestEndpoint,
  downloadHref,
}: {
  /** API สำหรับเพิกถอน เช่น /me/certificates/:id/revoke */
  endpoint: string;
  serialNumber: string;
  reasons?: RevocationReasonOption[];
  requireNote?: boolean;
  /** API ส่งคำขอเพิกถอน เช่น /me/certificates/:id/revocation-requests — ไม่ระบุ = เพิกถอนทันทีทุกเหตุผล */
  requestEndpoint?: string;
  /** หน้าดาวน์โหลดไฟล์ใหม่ — null = ใบนี้ดาวน์โหลดใหม่ไม่ได้ (ไม่มี key สำรอง), ไม่ระบุ = ไม่แสดงตัวเลือก "ไม่ต้องเพิกถอน" */
  downloadHref?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const noRevoke = reason === NO_REVOKE;
  // เหตุผลที่เลือกต้องรออนุมัติ — ยังไม่เลือกถือว่าเพิกถอนทันที (ข้อความเตือนแบบเข้มไว้ก่อน)
  const asRequest =
    Boolean(requestEndpoint) && reason !== null && !noRevoke && !URGENT_REVOCATION_REASONS.includes(reason);

  function openDialog() {
    setReason(null);
    setOpen(true);
  }

  async function handleConfirm(note: string) {
    if (!reason || noRevoke) throw new Error('กรุณาเลือกเหตุผลที่เพิกถอน');
    if (asRequest) {
      await apiMutate(requestEndpoint!, 'POST', { reason });
    } else {
      await apiMutate(endpoint, 'POST', requireNote ? { reason, note } : { reason });
    }
    router.refresh();
  }

  const options: RevocationReasonOption[] =
    downloadHref === undefined
      ? reasons
      : [
          {
            value: NO_REVOKE,
            label: 'ลืมรหัสผ่านไฟล์ หรือจะใช้บนเครื่องใหม่',
            hint: 'ไฟล์ไม่ได้หลุดไปถึงผู้อื่น',
          },
          ...reasons,
        ];

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
        confirmDisabled={noRevoke}
        reason={requireNote ? 'required' : undefined}
        reasonHint="บันทึกไว้ในประวัติของใบรับรองนี้ — ห้ามใส่ข้อมูลส่วนบุคคล"
        onConfirm={handleConfirm}
      >
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">
            {downloadHref === undefined ? 'เหตุผลที่เพิกถอน' : 'เกิดอะไรขึ้นกับใบรับรองนี้'}
          </legend>
          {options.map((r) => (
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
                {requestEndpoint && r.value !== NO_REVOKE && !URGENT_REVOCATION_REASONS.includes(r.value) && (
                  <span className="block text-muted">ต้องรอผู้ดูแลอนุมัติ</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        {noRevoke &&
          (downloadHref ? (
            <Alert title="ไม่ต้องเพิกถอน">
              <p>ดาวน์โหลดไฟล์ใหม่ได้ทุกเมื่อ พร้อมตั้งรหัสผ่านใหม่ — ใบรับรองเดิมใช้ต่อได้ตามปกติ</p>
              <Link
                href={downloadHref}
                className={`${buttonClasses({ variant: 'secondary', size: 'sm' })} mt-3`}
              >
                <Download className="size-4" aria-hidden />
                ดาวน์โหลดไฟล์ใหม่
              </Link>
            </Alert>
          ) : (
            <Alert title="ใบนี้ดาวน์โหลดใหม่ไม่ได้">
              ระบบไม่มี key สำรองของใบนี้ (นำเข้าจากระบบเดิม) ถ้ายังมีไฟล์เดิมและรหัสผ่านอยู่ให้ใช้ไฟล์เดิมต่อ
              ถ้าไม่มีแล้วให้เพิกถอนด้วยเหตุผลที่ตรงที่สุด แล้วขอใบใหม่
            </Alert>
          ))}
      </ConfirmDialog>
    </>
  );
}
