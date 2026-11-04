'use client';

import { useEffect, useRef, useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/Button';
import { apiMutate, setStepUpHandler, type StepUpCode } from '@/lib/api-client';
import { MfaCodeForm } from './MfaCodeForm';

type Pending = { code: StepUpCode; message: string };

/**
 * กล่องยืนยันตัวตนซ้ำก่อนรายการสำคัญ (docs/design/mfa.md) — วางครั้งเดียวใน root layout
 * apiMutate เรียกผ่าน setStepUpHandler เมื่อ API ตอบ MFA_STEP_UP_REQUIRED / RECENT_LOGIN_REQUIRED
 * - เปิด MFA: ใส่รหัส → POST /auth/mfa/step-up → apiMutate ส่งคำขอเดิมซ้ำให้เอง
 * - ไม่เปิด MFA: ยืนยันได้ทางเดียวคือเข้าสู่ระบบใหม่ (ทำรายการซ้ำเองหลัง login)
 */
export function StepUpDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  // หลายคำขอชนด่านพร้อมกัน → ใช้กล่องเดียว แล้วตอบทุกคำขอด้วยผลเดียวกัน
  const waiters = useRef<((ok: boolean) => void)[]>([]);

  useEffect(() => {
    setStepUpHandler(
      (code, message) =>
        new Promise<boolean>((resolve) => {
          waiters.current.push(resolve);
          setPending((current) => current ?? { code, message });
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    else if (!pending && dialog.open) dialog.close();
  }, [pending]);

  function finish(ok: boolean) {
    const resolvers = waiters.current;
    waiters.current = [];
    setPending(null);
    resolvers.forEach((resolve) => resolve(ok));
  }

  async function relogin() {
    setLoggingOut(true);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
    } finally {
      // ออกไม่สำเร็จก็ไปหน้า login อยู่ดี — session เดิมยังใช้ทำรายการนี้ไม่ได้
      window.location.assign('/login');
    }
  }

  const cancel = (
    <Button variant="secondary" fullWidth onClick={() => finish(false)}>
      ยกเลิก
    </Button>
  );

  return (
    <dialog
      ref={dialogRef}
      // กด Esc = ยกเลิก
      onClose={() => pending && finish(false)}
      aria-labelledby="step-up-dialog-title"
      className="mx-auto mt-auto mb-0 w-full max-w-full rounded-t-2xl bg-surface p-0 text-fg shadow-xl backdrop:bg-overlay sm:my-auto sm:max-w-md sm:rounded-2xl"
    >
      {pending && (
        <div className="space-y-4 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-6">
          <h2 id="step-up-dialog-title" className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="size-5 shrink-0 text-accent" aria-hidden />
            ยืนยันตัวตนอีกครั้ง
          </h2>
          {pending.code === 'MFA_STEP_UP_REQUIRED' ? (
            <>
              <p className="leading-relaxed text-muted">
                รายการนี้สำคัญ กรุณาใส่รหัสจากแอป Authenticator — ยืนยันแล้วทำรายการสำคัญอื่นต่อได้ 10 นาทีโดยไม่ต้องใส่รหัสอีก
              </p>
              <MfaCodeForm
                name="mfa-step-up"
                submitLabel="ยืนยันและทำรายการต่อ"
                secondaryAction={cancel}
                onSubmit={async (code) => {
                  await apiMutate('/auth/mfa/step-up', 'POST', { code });
                  finish(true);
                }}
              />
            </>
          ) : (
            <>
              <p className="leading-relaxed text-muted">{pending.message}</p>
              <p className="text-sm leading-relaxed text-muted">
                เปิดการยืนยันตัวตนสองขั้นตอนที่หน้าบัญชีของฉัน จะใส่รหัสจากแอปแทนการเข้าสู่ระบบใหม่ได้
              </p>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                {cancel}
                <Button fullWidth loading={loggingOut} onClick={relogin}>
                  {!loggingOut && <LogIn className="size-5" aria-hidden />}
                  เข้าสู่ระบบใหม่
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
