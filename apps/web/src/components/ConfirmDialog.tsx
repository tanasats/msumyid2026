'use client';

import { useEffect, useRef, useState } from 'react';
import { Alert } from './Alert';
import { Button } from './Button';

type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  /** หัวข้อเป็นคำถามที่บอกผลลัพธ์ เช่น "ปิดบัญชีนี้หรือไม่?" */
  title: string;
  description?: React.ReactNode;
  /** ข้อความปุ่มยืนยันเป็นคำกริยา เช่น "ปิดบัญชี" (ไม่ใช้ "ตกลง") */
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  /** ช่องกรอกเหตุผล: required = บังคับกรอก, optional = ไม่บังคับ, ไม่ระบุ = ไม่มีช่อง */
  reason?: 'required' | 'optional';
  /** งานที่ย้อนกลับไม่ได้: ต้องพิมพ์ข้อความนี้ให้ตรง (ไม่สนตัวพิมพ์) จึงกดยืนยันได้ เช่น อีเมลของบัญชี */
  confirmText?: { label: string; expected: string };
  /** throw Error พร้อมข้อความภาษาไทยเพื่อแสดงในกล่อง (กล่องไม่ปิด ข้อมูลที่กรอกไม่หาย) */
  onConfirm: (reason: string, confirmText: string) => Promise<void>;
};

/**
 * กล่องยืนยันสำหรับงานที่สำคัญ/ย้อนกลับไม่ได้ (docs/design/ui-guidelines.md หัวข้อ 5.4)
 * ใช้ <dialog> ของ browser: showModal() ทำ focus trap, กด Esc ปิด และกันการคลิกด้านหลังให้เอง
 * มือถือแสดงเป็น bottom sheet (ใกล้นิ้วโป้ง) จอใหญ่แสดงกลางจอ
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  reason,
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [reasonText, setReasonText] = useState('');
  const [typedText, setTypedText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setReasonText('');
      setTypedText('');
      setError(null);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (reason === 'required' && !reasonText.trim()) {
      setError('กรุณาระบุเหตุผล');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reasonText.trim(), typedText.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="confirm-dialog-title"
      className="mx-auto mt-auto mb-0 w-full max-w-full rounded-t-2xl bg-surface p-0 text-fg shadow-xl backdrop:bg-slate-900/50 sm:my-auto sm:max-w-md sm:rounded-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:p-6">
        <h2 id="confirm-dialog-title" className="text-lg font-semibold">
          {title}
        </h2>
        {description && <div className="leading-relaxed text-muted">{description}</div>}

        {reason && (
          <div className="space-y-1.5">
            <label htmlFor="confirm-dialog-reason" className="block text-sm font-medium">
              เหตุผล
              {reason === 'optional' && <span className="font-normal text-muted"> (ไม่บังคับ)</span>}
            </label>
            <textarea
              id="confirm-dialog-reason"
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              maxLength={500}
              className="block w-full rounded-lg border border-line-input bg-surface px-3 py-2 text-base"
            />
            <p className="text-sm text-muted">บันทึกไว้ในประวัติของบัญชีนี้</p>
          </div>
        )}

        {confirmText && (
          <div className="space-y-1.5">
            <label htmlFor="confirm-dialog-text" className="block text-sm font-medium">
              {confirmText.label}
            </label>
            <input
              id="confirm-dialog-text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base"
            />
          </div>
        )}

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
          {/* focus เริ่มที่ "ยกเลิก" กันกดยืนยันโดยไม่ตั้งใจ */}
          <Button variant="secondary" fullWidth autoFocus onClick={onClose} disabled={submitting}>
            ยกเลิก
          </Button>
          <Button
            type="submit"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            fullWidth
            loading={submitting}
            disabled={!!confirmText && typedText.trim().toLowerCase() !== confirmText.expected.toLowerCase()}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
