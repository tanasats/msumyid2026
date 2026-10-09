'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { apiMutate } from '@/lib/api-client';
import type { P12Response } from '@/lib/certificate';

const MIN_PASSWORD_LENGTH = 8;

type FieldErrors = Partial<Record<'password' | 'confirmPassword', string>>;

/** ดาวน์โหลดไฟล์ .p12 จากข้อมูล base64 ที่อยู่ในหน่วยความจำของหน้า (ไม่ผ่านเซิร์ฟเวอร์อีกรอบ) */
function downloadP12(p12Base64: string, fileName: string) {
  const bytes = Uint8Array.from(atob(p12Base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-pkcs12' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * ฟอร์มตั้งรหัสผ่านของไฟล์ .p12 แล้วดาวน์โหลด — ใช้ทั้งตอนขอใบใหม่และตอนดาวน์โหลดใหม่จาก key สำรอง
 * API คืนไฟล์ครั้งเดียว ระบบไม่เก็บไฟล์และรหัสผ่าน — เก็บไว้ในหน่วยความจำให้กดดาวน์โหลดซ้ำได้จนกว่าจะออกจากหน้า
 */
export function P12PasswordForm({
  endpoint,
  submitLabel,
  successTitle,
  children,
}: {
  /** API ที่รับ { p12Password, legacyP12 } แล้วคืน { p12, fileName } */
  endpoint: string;
  submitLabel: string;
  successTitle: string;
  /** ส่วนข้อมูลเหนือช่องรหัสผ่าน (เช่น ข้อมูลในใบรับรอง) */
  children?: React.ReactNode;
}) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [legacyP12, setLegacyP12] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<P12Response | null>(null);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `กรุณาตั้งรหัสผ่านอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`;
    }
    if (confirmPassword !== password) errors.confirmPassword = 'รหัสผ่านไม่ตรงกัน กรุณากรอกให้เหมือนช่องด้านบน';
    return errors;
  }

  // ตรวจเมื่อออกจากช่อง เฉพาะช่องที่กรอกแล้ว (ไม่ขึ้น error ทันทีที่ผ่านช่องว่าง)
  function validateOnBlur(field: keyof FieldErrors) {
    const value = field === 'password' ? password : confirmPassword;
    if (!value) return;
    setFieldErrors((prev) => ({ ...prev, [field]: validate()[field] }));
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
      const response = await apiMutate<P12Response>(endpoint, 'POST', { p12Password: password, legacyP12 });
      // ล้างรหัสผ่านออกจากหน้าทันทีที่ได้ไฟล์
      setPassword('');
      setConfirmPassword('');
      setResult(response);
      downloadP12(response.p12, response.fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="space-y-6">
        <Alert tone="success" title={successTitle}>
          ระบบดาวน์โหลดไฟล์ <span className="font-medium break-all">{result.fileName}</span> ให้แล้ว
          ถ้าไม่พบไฟล์ กดดาวน์โหลดอีกครั้งด้านล่าง
        </Alert>
        <Alert tone="warning" title="จดจำรหัสผ่านของไฟล์ไว้">
          ต้องใช้รหัสผ่านที่ตั้งไว้ทุกครั้งที่ติดตั้งใบรับรองในเครื่องหรือโปรแกรมอีเมล ระบบไม่เก็บรหัสผ่านนี้
          และจะดาวน์โหลดไฟล์จากหน้านี้ได้จนกว่าจะออกจากหน้า
        </Alert>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Link href="/certificates" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
            ไปที่ใบรับรองของฉัน
          </Link>
          <Button fullWidth onClick={() => downloadP12(result.p12, result.fileName)}>
            <Download className="size-5" aria-hidden />
            ดาวน์โหลดอีกครั้ง
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      {children}

      <section className="space-y-5 rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">ตั้งรหัสผ่านของไฟล์ใบรับรอง</h2>
          <p className="mt-1 text-sm text-muted">
            ใช้เปิดไฟล์ .p12 ตอนติดตั้งใบรับรอง ระบบไม่เก็บรหัสผ่านนี้ กรุณาจดจำไว้
          </p>
        </div>
        <TextField
          name="password"
          label="รหัสผ่าน"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => validateOnBlur('password')}
          hint={`อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`}
          error={fieldErrors.password}
          maxLength={128}
        />
        <TextField
          name="confirmPassword"
          label="ยืนยันรหัสผ่าน"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          onBlur={() => validateOnBlur('confirmPassword')}
          error={fieldErrors.confirmPassword}
          maxLength={128}
        />

        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={legacyP12}
            onChange={(e) => setLegacyP12(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-primary"
            aria-describedby="legacy-hint"
          />
          <span>
            <span className="block text-sm font-medium">ไฟล์สำหรับโปรแกรมรุ่นเก่า</span>
            <span id="legacy-hint" className="block text-sm text-muted">
              เลือกเมื่อเปิดไฟล์ไม่ได้ใน Windows, Outlook หรือ macOS รุ่นเก่า (ใช้การเข้ารหัสแบบเดิมที่ปลอดภัยน้อยกว่า)
            </span>
          </span>
        </label>
      </section>

      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        <Link href="/certificates" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
          ยกเลิก
        </Link>
        <Button type="submit" fullWidth loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
