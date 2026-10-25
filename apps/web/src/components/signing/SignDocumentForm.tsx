'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Download, FileUp, LoaderCircle, Lock, RotateCcw, X } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { ApiClientError, apiGet, apiMutate, downloadMyFile, uploadToStorage } from '@/lib/api-client';
import type { Certificate } from '@/lib/certificate';
import { formatBytes } from '@/lib/verify';
import { MAX_SIGNING_PDF_BYTES, type SigningBatch } from '@/lib/signing';
import { SigningPinForm } from './SigningPinForm';

const PIN_PATTERN = /^\d{6,12}$/;
/** ถามสถานะซ้ำทุกกี่ ms ระหว่างรอ worker (ลงนาม 1 ไฟล์ใช้ไม่กี่วินาที) */
const POLL_INTERVAL_MS = 2000;

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

type Step =
  | { step: 'form' }
  | { step: 'uploading'; progress: number }
  | { step: 'submitting' }
  | { step: 'waiting'; batch: SigningBatch }
  | { step: 'done'; batch: SigningBatch };

type FieldErrors = Partial<Record<'file' | 'pin', string>>;

type UploadResponse = { file: { id: string }; uploadUrl: string };

/**
 * ลงนาม PDF 1 ไฟล์ (มองไม่เห็น): อัปโหลดตรงเข้า storage → ส่งเข้าคิวพร้อม PIN → รอ worker → ดาวน์โหลด
 * ยังไม่ตั้ง PIN = ให้ตั้งก่อนในหน้าเดียวกัน — ทุกขั้นตอน API ตรวจสิทธิ์ ไฟล์ ใบรับรอง และ PIN อีกครั้ง
 */
export function SignDocumentForm({ certificates, hasPin: initialHasPin }: { certificates: Certificate[]; hasPin: boolean }) {
  const router = useRouter();
  const [hasPin, setHasPin] = useState(initialHasPin);
  const [file, setFile] = useState<File | null>(null);
  const [certificateId, setCertificateId] = useState(certificates[0]?.id ?? '');
  const [lockDocument, setLockDocument] = useState(false);
  const [pin, setPin] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<Step>({ step: 'form' });
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // รอ worker: ถามสถานะซ้ำจนกว่าชุดจะจบ (ออกจากหน้า = หยุดถาม งานยังทำต่อ ดูผลได้ในประวัติ)
  const waitingBatchId = state.step === 'waiting' ? state.batch.id : null;
  useEffect(() => {
    if (!waitingBatchId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { batch } = await apiGet<{ batch: SigningBatch }>(`/me/signing-batches/${waitingBatchId}`, controller.signal);
        if (batch.status !== 'processing') {
          setState({ step: 'done', batch });
          router.refresh();
          return;
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // เครือข่ายสะดุด: ถามใหม่รอบถัดไป
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [waitingBatchId, router]);

  if (!hasPin) {
    return (
      <div className="space-y-4">
        <Alert tone="info" title="ตั้ง PIN ลงนามก่อนเริ่มใช้งาน">
          ระบบลงนามด้วยใบรับรองของคุณที่สำรองไว้ในระบบ จึงต้องใส่ PIN ที่คุณตั้งเองทุกครั้งที่ลงนาม
        </Alert>
        <SigningPinForm mode="set" onDone={() => setHasPin(true)} />
      </div>
    );
  }

  function pickFile(files: FileList | null) {
    const picked = files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!picked) return;
    if (picked.type !== 'application/pdf' && !picked.name.toLowerCase().endsWith('.pdf')) {
      setFieldErrors((e) => ({ ...e, file: 'กรุณาเลือกไฟล์ PDF' }));
      return;
    }
    if (picked.size === 0 || picked.size > MAX_SIGNING_PDF_BYTES) {
      setFieldErrors((e) => ({ ...e, file: `ไฟล์ต้องไม่ว่างและไม่เกิน ${formatBytes(MAX_SIGNING_PDF_BYTES)}` }));
      return;
    }
    setFile(picked);
    setFieldErrors((e) => ({ ...e, file: undefined }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (!file) errors.file = 'กรุณาเลือกไฟล์ PDF ที่จะลงนาม';
    if (!PIN_PATTERN.test(pin)) errors.pin = 'กรุณาใส่ PIN ลงนาม (ตัวเลข 6–12 หลัก)';
    setFieldErrors(errors);
    if (errors.file) return document.getElementById('field-file')?.focus();
    if (errors.pin) return document.getElementById('field-pin')?.focus();

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setState({ step: 'uploading', progress: 0 });
    try {
      const upload = await apiMutate<UploadResponse>('/me/files', 'POST', {
        purpose: 'signing_source',
        originalName: file!.name,
        mimeType: 'application/pdf',
        size: file!.size,
      });
      await uploadToStorage(upload.uploadUrl, file!, {
        contentType: 'application/pdf',
        signal: controller.signal,
        onProgress: (progress) => setState((s) => (s.step === 'uploading' ? { ...s, progress } : s)),
      });
      setState({ step: 'submitting' });
      await apiMutate(`/me/files/${upload.file.id}/complete`, 'POST');
      const { batch } = await apiMutate<{ batch: SigningBatch }>('/me/signing-batches', 'POST', {
        fileId: upload.file.id,
        certificateId,
        lockDocument,
        pin,
      });
      setPin('');
      setState({ step: 'waiting', batch });
    } catch (err) {
      setState({ step: 'form' });
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (err instanceof ApiClientError && (err.code === 'PIN_INCORRECT' || err.code === 'PIN_LOCKED')) {
        setPin('');
        setFieldErrors({ pin: err.message });
        document.getElementById('field-pin')?.focus();
        return;
      }
      setError(err instanceof ApiClientError ? err.message : 'ลงนามไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      abortRef.current = null;
    }
  }

  function reset() {
    setFile(null);
    setPin('');
    setFieldErrors({});
    setError(null);
    setState({ step: 'form' });
  }

  if (state.step === 'waiting' || state.step === 'submitting') {
    return (
      <section className="flex flex-col items-center rounded-xl border border-line bg-surface p-8 text-center shadow-card" aria-live="polite">
        <LoaderCircle className="size-10 text-accent motion-safe:animate-spin" aria-hidden />
        <h2 className="mt-4 font-display text-lg font-semibold">กำลังลงนามเอกสาร</h2>
        <p className="mt-1 text-sm text-muted">
          ลงนามและประทับเวลาด้วยบริการของมหาวิทยาลัย ใช้เวลาไม่กี่วินาที ออกจากหน้านี้ได้ ผลจะอยู่ในประวัติด้านล่าง
        </p>
      </section>
    );
  }

  if (state.step === 'done') {
    const job = state.batch.jobs[0];
    const again = (
      <Button variant="secondary" fullWidth onClick={reset}>
        <RotateCcw className="size-5" aria-hidden />
        ลงนามไฟล์อื่น
      </Button>
    );
    if (job?.status === 'signed' && job.signedFileId) {
      const fileId = job.signedFileId;
      return (
        <div className="space-y-4">
          <Alert tone="success" title="ลงนามเอกสารแล้ว">
            <span className="break-all">{job.originalName}</span>
            {state.batch.lockDocument && ' — ล็อกเอกสารแล้ว แก้ไขต่อไม่ได้'} ดาวน์โหลดได้ถึง{' '}
            {dateFormatter.format(new Date(state.batch.expiresAt))} หลังจากนั้นระบบจะลบไฟล์
          </Alert>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            {again}
            <DownloadButton fileId={fileId} />
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <Alert tone="danger" title="ลงนามไม่สำเร็จ">
          {job?.error?.message ?? 'ลงนามไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'}
        </Alert>
        <div className="flex justify-end">{again}</div>
      </div>
    );
  }

  const uploading = state.step === 'uploading';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      <section className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">1. เลือกไฟล์</h2>
        <div className="space-y-1.5">
          <label
            htmlFor="field-file"
            className={`flex min-h-24 cursor-pointer items-center gap-4 rounded-lg border-2 border-dashed p-4 transition hover:bg-surface-hover ${
              fieldErrors.file ? 'border-danger' : 'border-line'
            }`}
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
              <FileUp className="size-6" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block font-medium break-all">{file ? file.name : 'เลือกไฟล์ PDF'}</span>
              <span className="block text-sm text-muted">
                {file ? formatBytes(file.size) : `PDF 1 ไฟล์ ขนาดไม่เกิน ${formatBytes(MAX_SIGNING_PDF_BYTES)} ที่ยังไม่มีลายมือชื่อดิจิทัล`}
              </span>
            </span>
          </label>
          <input
            ref={inputRef}
            id="field-file"
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            disabled={uploading}
            aria-invalid={fieldErrors.file ? true : undefined}
            aria-describedby={fieldErrors.file ? 'field-file-error' : undefined}
            onChange={(e) => pickFile(e.target.files)}
          />
          {fieldErrors.file && (
            <p id="field-file-error" className="text-sm text-danger-fg">
              {fieldErrors.file}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">2. ใบรับรองและการล็อก</h2>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">ลงนามด้วยใบรับรอง</legend>
          {certificates.map((c) => (
            <label
              key={c.id}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                certificateId === c.id ? 'border-accent bg-accent-soft' : 'border-line'
              }`}
            >
              <input
                type="radio"
                name="certificate"
                value={c.id}
                checked={certificateId === c.id}
                onChange={() => setCertificateId(c.id)}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {c.kind === 'supplementary' ? 'ใบรับรองเสริม' : 'ใบรับรองประจำตัว'} — {c.subjectCn}
                </span>
                <span className="block text-sm text-muted">
                  ใช้ได้ถึง <span className="tabular-nums">{dateFormatter.format(new Date(c.notAfter))}</span>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={lockDocument}
            onChange={(e) => setLockDocument(e.target.checked)}
            className="mt-0.5 size-5 shrink-0 accent-primary"
            aria-describedby="lock-hint"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Lock className="size-4" aria-hidden />
              ล็อกเอกสารหลังลงนาม
            </span>
            <span id="lock-hint" className="block text-sm text-muted">
              Acrobat แสดงเป็นเอกสารรับรอง (Certified) แก้ไขหรือลงนามเพิ่มแล้วลายมือชื่อจะไม่ผ่าน — เลือกเมื่อเป็นฉบับสุดท้าย
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">3. ยืนยันด้วย PIN</h2>
        <TextField
          name="pin"
          label="PIN ลงนาม"
          type="password"
          inputMode="numeric"
          // new-password: กัน browser เติมรหัสผ่านที่บันทึกไว้ลงช่อง PIN
          autoComplete="new-password"
          maxLength={12}
          value={pin}
          onChange={(e) => setPin(e.target.value.trim())}
          error={fieldErrors.pin}
          disabled={uploading}
        />
      </section>

      {uploading && (
        <div className="space-y-2" aria-live="polite">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-neutral-soft"
            role="progressbar"
            aria-label="ความคืบหน้าการอัปโหลด"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.progress * 100)}
          >
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(state.progress * 100)}%` }} />
          </div>
          <p className="text-sm text-muted">กำลังอัปโหลด {Math.round(state.progress * 100)}%</p>
        </div>
      )}

      <div className="sticky bottom-0 -mx-4 flex flex-col-reverse gap-3 border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
        {uploading && (
          <Button variant="secondary" fullWidth onClick={() => abortRef.current?.abort()}>
            <X className="size-5" aria-hidden />
            ยกเลิก
          </Button>
        )}
        <Button type="submit" fullWidth loading={uploading}>
          <CircleCheck className="size-5" aria-hidden />
          ลงนามเอกสาร
        </Button>
      </div>
    </form>
  );
}

/** ดาวน์โหลดไฟล์ที่ลงนามแล้ว (ขอ URL อายุ 5 นาทีทุกครั้งที่กด) */
export function DownloadButton({ fileId, size = 'md' }: { fileId: string; size?: 'md' | 'sm' }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-stretch gap-1 sm:items-end">
      <Button
        size={size}
        fullWidth
        variant={size === 'sm' ? 'secondary' : 'primary'}
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            await downloadMyFile(fileId);
          } catch (err) {
            setError(err instanceof ApiClientError ? err.message : 'ดาวน์โหลดไม่สำเร็จ กรุณาลองใหม่');
          } finally {
            setLoading(false);
          }
        }}
      >
        <Download className="size-5" aria-hidden />
        ดาวน์โหลด
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger-fg">
          {error}
        </span>
      )}
    </span>
  );
}
