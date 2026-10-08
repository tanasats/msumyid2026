'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, CircleSlash, RotateCcw, ShieldX } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiMutate } from '@/lib/api-client';

type Action = 'approve' | 'reject' | 'deactivate' | 'activate';

const ACTIONS: Record<
  Action,
  {
    title: string;
    description: string;
    confirmLabel: string;
    tone: 'primary' | 'danger';
    reason: 'required' | 'optional';
  }
> = {
  approve: {
    title: 'อนุมัติบัญชีนี้หรือไม่?',
    description: 'ผู้ใช้จะได้รับบทบาทบุคลากรภายนอกและใช้งานระบบได้ทันที',
    confirmLabel: 'อนุมัติบัญชี',
    tone: 'primary',
    reason: 'optional',
  },
  reject: {
    title: 'ไม่อนุมัติบัญชีนี้หรือไม่?',
    description: 'ผู้ใช้จะเข้าระบบได้แต่เห็นเฉพาะหน้าแจ้งว่าไม่ได้รับอนุมัติ',
    confirmLabel: 'ไม่อนุมัติ',
    tone: 'danger',
    reason: 'required',
  },
  deactivate: {
    title: 'ปิดบัญชีนี้หรือไม่?',
    description: 'ผู้ใช้จะถูกออกจากระบบทันทีและเข้าระบบไม่ได้จนกว่าจะเปิดบัญชีคืน',
    confirmLabel: 'ปิดบัญชี',
    tone: 'danger',
    reason: 'required',
  },
  activate: {
    title: 'เปิดบัญชีนี้คืนหรือไม่?',
    description: 'ผู้ใช้จะกลับมาเข้าระบบได้ตามสิทธิ์เดิม',
    confirmLabel: 'เปิดบัญชี',
    tone: 'primary',
    reason: 'required',
  },
};

/**
 * ปุ่มจัดการบัญชี (อนุมัติ/ไม่อนุมัติ, ปิด/เปิดบัญชี) — แสดงเฉพาะปุ่มที่ผู้ใช้ปัจจุบันมีสิทธิ์ (เพื่อ UX)
 * การตรวจสิทธิ์จริงอยู่ที่ API ทุกครั้ง
 */
export function UserAccountActions({
  userId,
  isActive,
  approvalStatus,
  canApprove,
  canDeactivate,
}: {
  userId: string;
  isActive: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  canApprove: boolean;
  canDeactivate: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  const config = action ? ACTIONS[action] : null;

  const showApprove = canApprove && isActive && approvalStatus !== 'approved';
  const showReject = canApprove && isActive && approvalStatus === 'pending';
  if (!showApprove && !showReject && !canDeactivate) return null;

  async function confirm(reason: string) {
    if (!action) return;
    await apiMutate(`/admin/users/${userId}/${action}`, 'POST', reason ? { reason } : {});
    // โหลดข้อมูลหน้าใหม่จาก server (สถานะ, ประวัติ)
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">การจัดการบัญชี</h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {showApprove && (
          <Button fullWidth onClick={() => setAction('approve')}>
            <CircleCheck className="size-5" aria-hidden />
            อนุมัติบัญชี
          </Button>
        )}
        {showReject && (
          <Button variant="secondary" fullWidth onClick={() => setAction('reject')}>
            <ShieldX className="size-5" aria-hidden />
            ไม่อนุมัติ
          </Button>
        )}
        {canDeactivate &&
          (isActive ? (
            <Button variant="secondary" fullWidth className="text-red-800" onClick={() => setAction('deactivate')}>
              <CircleSlash className="size-5" aria-hidden />
              ปิดบัญชี
            </Button>
          ) : (
            <Button variant="secondary" fullWidth onClick={() => setAction('activate')}>
              <RotateCcw className="size-5" aria-hidden />
              เปิดบัญชีคืน
            </Button>
          ))}
      </div>

      <ConfirmDialog
        open={config !== null}
        onClose={() => setAction(null)}
        title={config?.title ?? ''}
        description={config?.description}
        confirmLabel={config?.confirmLabel ?? ''}
        tone={config?.tone}
        reason={config?.reason}
        onConfirm={confirm}
      />
    </section>
  );
}
