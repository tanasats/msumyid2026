'use client';

import { useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { ApiClientError, apiMutate } from '@/lib/api-client';

const PIN_PATTERN = /^\d{6,12}$/;

type FieldErrors = Partial<Record<'currentPin' | 'newPin' | 'confirmPin', string>>;

/**
 * ตั้ง/เปลี่ยน PIN ลงนาม (PUT /me/signing-pin) — PIN ใช้ยืนยันตัวทุกครั้งที่ลงนาม
 * เปลี่ยน PIN: ใส่ PIN เดิม หรือเว้นว่างถ้าเพิ่งเข้าสู่ระบบภายใน 10 นาที (กรณีลืม PIN) — API ตรวจเงื่อนไขเอง
 */
export function SigningPinForm({
  mode,
  onDone,
  cancel,
}: {
  mode: 'set' | 'change';
  onDone: () => void;
  /** ปุ่มยกเลิก/ย้อนกลับ (ถ้ามี) */
  cancel?: React.ReactNode;
}) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (mode === 'change' && currentPin && !PIN_PATTERN.test(currentPin)) errors.currentPin = 'PIN เดิมเป็นตัวเลข 6–12 หลัก';
    if (!PIN_PATTERN.test(newPin)) errors.newPin = 'กรุณาตั้ง PIN เป็นตัวเลข 6–12 หลัก';
    if (confirmPin !== newPin) errors.confirmPin = 'PIN ไม่ตรงกัน กรุณากรอกให้เหมือนช่องด้านบน';
    return errors;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    const firstInvalid = Object.keys(errors)[0];
    if (firstInvalid) {
      document.getElementById(`field-${firstInvalid}`)?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiMutate('/me/signing-pin', 'PUT', { newPin, ...(currentPin ? { currentPin } : {}) });
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? { code: err.code, message: err.message }
          : { code: 'UNKNOWN', message: 'ตั้ง PIN ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' },
      );
    } finally {
      setSubmitting(false);
    }
  }

  // new-password: กัน browser เติมรหัสผ่านที่บันทึกไว้ลงช่อง PIN (autoComplete=off ใช้กับช่อง password ไม่ได้ผล)
  const pinInput = { type: 'password', inputMode: 'numeric', autoComplete: 'new-password', maxLength: 12 } as const;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && (
        <Alert tone="danger" title={error.code === 'RECENT_LOGIN_REQUIRED' ? 'ต้องยืนยันตัวตนก่อนตั้ง PIN ใหม่' : undefined}>
          {error.message}
        </Alert>
      )}
      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">{mode === 'set' ? 'ตั้ง PIN ลงนาม' : 'เปลี่ยน PIN ลงนาม'}</h2>
          <p className="mt-1 text-sm text-muted">
            ใช้ยืนยันตัวทุกครั้งที่ลงนามเอกสาร แยกจากรหัสผ่านไฟล์ใบรับรอง ใส่ผิด 5 ครั้งติดกันจะถูกล็อก 15 นาที
          </p>
        </div>
        {mode === 'change' && (
          <TextField
            name="currentPin"
            label="PIN เดิม"
            optional
            hint="ลืม PIN: ออกจากระบบแล้วเข้าสู่ระบบใหม่ จากนั้นตั้ง PIN ใหม่ภายใน 10 นาทีโดยเว้นช่องนี้ว่าง"
            value={currentPin}
            onChange={(e) => setCurrentPin(e.target.value.trim())}
            error={fieldErrors.currentPin}
            {...pinInput}
          />
        )}
        <TextField
          name="newPin"
          label={mode === 'set' ? 'PIN' : 'PIN ใหม่'}
          hint="ตัวเลข 6–12 หลัก ห้ามเป็นเลขซ้ำหรือเรียงกัน (เช่น 111111, 123456)"
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.trim())}
          error={fieldErrors.newPin}
          {...pinInput}
        />
        <TextField
          name="confirmPin"
          label="ยืนยัน PIN"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value.trim())}
          error={fieldErrors.confirmPin}
          {...pinInput}
        />
      </section>
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        {cancel}
        <Button type="submit" fullWidth loading={submitting}>
          {mode === 'set' ? 'ตั้ง PIN' : 'เปลี่ยน PIN'}
        </Button>
      </div>
    </form>
  );
}
