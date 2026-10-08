'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, CircleSlash, RotateCcw, ShieldX, Trash2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ACCOUNT_TYPE_LABELS, type AccountType } from '@/lib/account-type';
import { apiMutate } from '@/lib/api-client';

type Action = 'approve' | 'reject' | 'deactivate' | 'activate' | 'delete';

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
  delete: {
    title: 'ลบบัญชีและข้อมูลส่วนบุคคลหรือไม่?',
    description:
      'ชื่อ อีเมล รูป ข้อมูลบุคลากร และบทบาททั้งหมดจะถูกลบถาวร ย้อนกลับไม่ได้ ถ้าต้องการหยุดการใช้งานชั่วคราวให้ใช้ "ปิดบัญชี" แทน — ห้ามใส่ข้อมูลส่วนบุคคลในเหตุผล',
    confirmLabel: 'ลบบัญชีถาวร',
    tone: 'danger',
    reason: 'required',
  },
};

/**
 * ปุ่มจัดการบัญชี (อนุมัติ/ไม่อนุมัติ, ปิด/เปิดบัญชี) — แสดงเฉพาะปุ่มที่ผู้ใช้ปัจจุบันมีสิทธิ์ (เพื่อ UX)
 * การตรวจสิทธิ์จริงอยู่ที่ API ทุกครั้ง
 */
export function UserAccountActions({
  userId,
  email,
  isActive,
  approvalStatus,
  accountType,
  approveBlockedReason,
  canApprove,
  canDeactivate,
  canDelete,
}: {
  userId: string;
  /** ใช้เป็นข้อความที่ต้องพิมพ์ยืนยันก่อนลบ */
  email: string;
  isActive: boolean;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  accountType: AccountType;
  /** มีค่า = ยังอนุมัติไม่ได้ (เช่น บัญชีหน่วยงานยังไม่กำหนดหน่วยงาน/ผู้รับผิดชอบ) ปุ่มจะถูกปิดพร้อมเหตุผล */
  approveBlockedReason?: string;
  canApprove: boolean;
  canDeactivate: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<Action | null>(null);
  // ข้อความยืนยันการอนุมัติบอกบทบาทที่จะได้ตามประเภทบัญชี
  const config =
    action === 'approve'
      ? {
          ...ACTIONS.approve,
          description: `ผู้ใช้จะได้รับบทบาท${ACCOUNT_TYPE_LABELS[accountType]}และใช้งานระบบได้ทันที`,
        }
      : action
        ? ACTIONS[action]
        : null;

  const showApprove = canApprove && isActive && approvalStatus !== 'approved';
  const showReject = canApprove && isActive && approvalStatus === 'pending';
  if (!showApprove && !showReject && !canDeactivate && !canDelete) return null;

  async function confirm(reason: string, confirmText: string) {
    if (!action) return;
    if (action === 'delete') {
      await apiMutate(`/admin/users/${userId}`, 'DELETE', { reason, confirmEmail: confirmText });
      // บัญชีไม่มีแล้ว กลับไปหน้ารายชื่อ
      router.push('/admin/users');
      router.refresh();
      return;
    }
    await apiMutate(`/admin/users/${userId}/${action}`, 'POST', reason ? { reason } : {});
    // โหลดข้อมูลหน้าใหม่จาก server (สถานะ, ประวัติ)
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface p-5 sm:p-6">
      <h2 className="text-lg font-semibold">การจัดการบัญชี</h2>
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {showApprove && (
          <Button
            fullWidth
            disabled={Boolean(approveBlockedReason)}
            aria-describedby={approveBlockedReason ? 'approve-blocked-reason' : undefined}
            onClick={() => setAction('approve')}
          >
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
      {showApprove && approveBlockedReason && (
        <p id="approve-blocked-reason" className="text-sm text-muted">
          {approveBlockedReason}
        </p>
      )}

      {/* งานที่ย้อนกลับไม่ได้ แยกไว้ท้ายสุดให้เห็นชัดว่าต่างจากปุ่มอื่น */}
      {canDelete && (
        <div className="border-t border-line pt-4">
          <p className="mb-3 text-sm text-muted">
            ลบถาวรใช้กับคำขอลบข้อมูลตาม PDPA หรือบัญชีที่สร้างผิดเท่านั้น ข้อมูลที่ลบกู้คืนไม่ได้
          </p>
          <Button variant="danger" fullWidth onClick={() => setAction('delete')}>
            <Trash2 className="size-5" aria-hidden />
            ลบบัญชีและข้อมูลส่วนบุคคล
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={config !== null}
        onClose={() => setAction(null)}
        title={config?.title ?? ''}
        description={config?.description}
        confirmLabel={config?.confirmLabel ?? ''}
        tone={config?.tone}
        reason={config?.reason}
        confirmText={action === 'delete' ? { label: `พิมพ์อีเมล ${email} เพื่อยืนยัน`, expected: email } : undefined}
        onConfirm={confirm}
      />
    </section>
  );
}
