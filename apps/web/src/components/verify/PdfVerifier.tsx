'use client';

import { useRef, useState } from 'react';
import { FileSearch, FileUp, RotateCcw, X } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { StatusState } from '@/components/StatusState';
import { ApiClientError, apiUpload } from '@/lib/api-client';
import { MAX_PDF_BYTES, formatBytes, type VerificationReport } from '@/lib/verify';
import { SignatureResultCard } from './SignatureResultCard';

type State =
  | { step: 'idle'; error?: string }
  | { step: 'uploading'; file: File; progress: number }
  | { step: 'done'; file: File; report: VerificationReport };

/** อัปโหลด PDF ไปตรวจลายมือชื่อ (POST /verify/pdf) — ไฟล์ไม่ถูกจัดเก็บ */
export function PdfVerifier() {
  const [state, setState] = useState<State>({ step: 'idle' });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function verify(file: File) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setState({ step: 'idle', error: 'กรุณาเลือกไฟล์ PDF' });
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setState({ step: 'idle', error: `ไฟล์ใหญ่เกิน ${formatBytes(MAX_PDF_BYTES)}` });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setState({ step: 'uploading', file, progress: 0 });
    try {
      const report = await apiUpload<VerificationReport>('/verify/pdf', file, {
        contentType: 'application/pdf',
        signal: controller.signal,
        onProgress: (progress) => setState((s) => (s.step === 'uploading' ? { ...s, progress } : s)),
      });
      setState({ step: 'done', file, report });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setState({ step: 'idle' });
        return;
      }
      setState({
        step: 'idle',
        error: err instanceof ApiClientError ? err.message : 'ตรวจไม่สำเร็จ กรุณาลองใหม่อีกครั้ง',
      });
    } finally {
      abortRef.current = null;
    }
  }

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (file) void verify(file);
    // ล้างค่า เพื่อให้เลือกไฟล์เดิมซ้ำได้
    if (inputRef.current) inputRef.current.value = '';
  }

  function reset() {
    setState({ step: 'idle' });
  }

  if (state.step === 'done') {
    return <Results file={state.file} report={state.report} onReset={reset} />;
  }

  const uploading = state.step === 'uploading';

  return (
    <div className="space-y-4">
      {state.step === 'idle' && state.error && <Alert tone="danger">{state.error}</Alert>}

      <label
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) pick(e.dataTransfer.files);
        }}
        className={`flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
        } ${uploading ? 'cursor-default' : 'cursor-pointer hover:bg-surface-hover'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          disabled={uploading}
          onChange={(e) => pick(e.target.files)}
        />
        {uploading ? (
          <div className="w-full max-w-sm space-y-3" aria-live="polite">
            <p className="font-medium break-all">{state.file.name}</p>
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
            <p className="text-sm text-muted">
              {state.progress < 1 ? `กำลังอัปโหลด ${Math.round(state.progress * 100)}%` : 'กำลังตรวจลายมือชื่อ...'}
            </p>
          </div>
        ) : (
          <>
            <span className="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
              <FileUp className="size-7" aria-hidden />
            </span>
            <span className="font-medium">เลือกไฟล์ PDF หรือลากไฟล์มาวางที่นี่</span>
            <span className="text-sm text-muted">ไฟล์ PDF ขนาดไม่เกิน {formatBytes(MAX_PDF_BYTES)}</span>
            <span className={buttonClasses({ fullWidth: true })}>เลือกไฟล์</span>
          </>
        )}
      </label>

      {uploading && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => abortRef.current?.abort()}>
            <X className="size-5" aria-hidden />
            ยกเลิก
          </Button>
        </div>
      )}
    </div>
  );
}

function Results({ file, report, onReset }: { file: File; report: VerificationReport; onReset: () => void }) {
  const total = report.signatures.length;
  const counts = {
    valid: report.signatures.filter((s) => s.verdict === 'valid').length,
    invalid: report.signatures.filter((s) => s.verdict === 'invalid').length,
  };

  const again = (
    <Button variant="secondary" onClick={onReset}>
      <RotateCcw className="size-5" aria-hidden />
      ตรวจไฟล์อื่น
    </Button>
  );

  if (total === 0) {
    return (
      <StatusState icon={FileSearch} title="ไม่พบลายมือชื่อดิจิทัลในไฟล์นี้" action={again}>
        <span className="break-all">{file.name}</span> ไม่มีลายมือชื่อดิจิทัล (ภาพลายเซ็นที่วางบนหน้าเอกสารไม่ใช่ลายมือชื่อดิจิทัล)
      </StatusState>
    );
  }

  const summary =
    counts.invalid > 0
      ? { tone: 'danger' as const, title: `พบลายมือชื่อที่ไม่ถูกต้อง ${counts.invalid} จาก ${total} รายการ` }
      : counts.valid === total
        ? { tone: 'success' as const, title: total === 1 ? 'ลายมือชื่อถูกต้อง' : `ลายมือชื่อถูกต้องทั้ง ${total} รายการ` }
        : { tone: 'warning' as const, title: `ยืนยันความถูกต้องได้ ${counts.valid} จาก ${total} รายการ` };

  return (
    <div className="space-y-4">
      <Alert tone={summary.tone} title={summary.title}>
        <span className="break-all">{file.name}</span> ({formatBytes(file.size)})
      </Alert>
      {report.signatures.map((signature) => (
        <SignatureResultCard key={signature.index} report={signature} total={total} />
      ))}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{again}</div>
    </div>
  );
}
