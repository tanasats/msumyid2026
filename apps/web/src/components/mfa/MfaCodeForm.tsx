'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { ApiClientError } from '@/lib/api-client';

/**
 * ฟอร์มใส่รหัส MFA (6 หลักจากแอป หรือรหัสกู้คืน) — ใช้ตอนเข้าสู่ระบบ ยืนยันซ้ำ ปิด MFA และออกรหัสกู้คืนใหม่
 * onSubmit ส่งรหัสไป API เอง ฟอร์มนี้จัดการแค่สถานะกำลังส่ง/ข้อความ error
 */
export function MfaCodeForm({
  name,
  submitLabel,
  onSubmit,
  allowRecoveryCode = true,
  submitVariant = 'primary',
  secondaryAction,
}: {
  /** ชื่อช่อง (ต้องไม่ซ้ำในหน้าเดียว) */
  name: string;
  submitLabel: string;
  onSubmit: (code: string) => Promise<void>;
  allowRecoveryCode?: boolean;
  submitVariant?: 'primary' | 'danger';
  secondaryAction?: React.ReactNode;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(code.trim());
      setCode('');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {useRecovery ? (
        <TextField
          name={`${name}-recovery`}
          label="รหัสกู้คืน"
          hint="รูปแบบ XXXX-XXXX-XXXX-XXXX ใช้ได้รหัสละครั้ง"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={32}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      ) : (
        <TextField
          name={`${name}-totp`}
          label="รหัส 6 หลักจากแอป Authenticator"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      )}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {allowRecoveryCode ? (
          <button
            type="button"
            className="min-h-11 text-left text-sm font-medium text-accent underline-offset-4 hover:underline"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError(undefined);
            }}
          >
            {useRecovery ? 'ใช้รหัสจากแอปแทน' : 'ใช้แอปไม่ได้? ใช้รหัสกู้คืน'}
          </button>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row">
          {secondaryAction}
          <Button type="submit" variant={submitVariant} fullWidth loading={submitting} disabled={code.trim().length < 6}>
            {!submitting && <KeyRound className="size-5" aria-hidden />}
            {submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
