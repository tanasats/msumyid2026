'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { apiMutate } from '@/lib/api-client';
import type { MfaStatus, RecoveryCodes } from '@/lib/mfa';
import { MfaCodeForm } from './MfaCodeForm';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

type Mode = { kind: 'idle' } | { kind: 'regenerate' } | { kind: 'codes'; codes: string[] } | { kind: 'disable' };

/** ส่วน "ความปลอดภัยของบัญชี" ในหน้าบัญชีของฉัน — สถานะ MFA, ออกรหัสกู้คืนใหม่, ปิด MFA (ทุกอย่างต้องใส่รหัสปัจจุบัน) */
export function MfaSettings({ status, email }: { status: MfaStatus; email: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });
  const cancel = (
    <Button variant="secondary" fullWidth onClick={() => setMode({ kind: 'idle' })}>
      ยกเลิก
    </Button>
  );

  if (!status.enabled) {
    return (
      <div className="mt-4 space-y-4">
        <p className="flex items-center gap-2 font-medium">
          <ShieldOff className="size-5 shrink-0 text-muted" aria-hidden />
          ยังไม่เปิดใช้งาน
        </p>
        <p className="text-sm leading-relaxed text-muted">
          เพิ่มรหัสจากแอป Authenticator ในโทรศัพท์ นอกจากบัญชี Google — แม้บัญชี Google ถูกขโมย ผู้อื่นก็เข้าระบบแทนคุณไม่ได้
        </p>
        <Link href="/mfa/setup" className={buttonClasses({ fullWidth: true })}>
          {status.pending ? 'ตั้งค่าต่อ' : 'เปิดใช้งาน'}
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <p className="flex items-center gap-2 font-medium text-success-fg">
        <ShieldCheck className="size-5 shrink-0" aria-hidden />
        เปิดใช้งานแล้ว (แอป Authenticator)
      </p>
      <p className="text-sm text-muted">รหัสกู้คืนที่ยังไม่ใช้: {status.recoveryCodesRemaining} รหัส</p>
      {status.recoveryCodesRemaining <= 3 && mode.kind === 'idle' && (
        <Alert tone="warning">รหัสกู้คืนใกล้หมด ออกรหัสชุดใหม่ไว้ก่อนโทรศัพท์หาย</Alert>
      )}
      {status.required && (
        <p className="text-sm text-muted">บทบาทของคุณบังคับใช้การยืนยันตัวตนสองขั้นตอน จึงปิดไม่ได้ — เปลี่ยนโทรศัพท์ให้ติดต่อผู้ดูแลระบบ</p>
      )}

      {mode.kind === 'idle' && (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button variant="secondary" fullWidth onClick={() => setMode({ kind: 'regenerate' })}>
            ออกรหัสกู้คืนชุดใหม่
          </Button>
          {!status.required && (
            <Button variant="ghost" fullWidth onClick={() => setMode({ kind: 'disable' })}>
              ปิดการยืนยันตัวตนสองขั้นตอน
            </Button>
          )}
        </div>
      )}

      {mode.kind === 'regenerate' && (
        <>
          <p className="text-sm">ใส่รหัสปัจจุบันเพื่อออกรหัสกู้คืนชุดใหม่ — รหัสชุดเดิมจะใช้ไม่ได้ทันที</p>
          <MfaCodeForm
            name="mfa-regenerate"
            submitLabel="ออกรหัสชุดใหม่"
            secondaryAction={cancel}
            onSubmit={async (code) => {
              const result = await apiMutate<RecoveryCodes>('/me/mfa/recovery-codes', 'POST', { code });
              setMode({ kind: 'codes', codes: result.recoveryCodes });
            }}
          />
        </>
      )}

      {mode.kind === 'codes' && (
        <RecoveryCodesPanel
          codes={mode.codes}
          email={email}
          doneLabel="เสร็จสิ้น"
          onDone={() => {
            setMode({ kind: 'idle' });
            router.refresh();
          }}
        />
      )}

      {mode.kind === 'disable' && (
        <>
          <Alert tone="warning">หลังปิด การเข้าสู่ระบบจะใช้เฉพาะบัญชี Google ระบบจะแจ้งเตือนทางอีเมล</Alert>
          <MfaCodeForm
            name="mfa-disable"
            submitLabel="ปิดใช้งาน"
            submitVariant="danger"
            secondaryAction={cancel}
            onSubmit={async (code) => {
              await apiMutate('/me/mfa', 'DELETE', { code });
              setMode({ kind: 'idle' });
              router.refresh();
            }}
          />
        </>
      )}
    </div>
  );
}
