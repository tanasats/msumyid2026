'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, CircleSlash, FileArchive, LoaderCircle, RotateCcw } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button, buttonClasses } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { ApiClientError, apiGet, apiMutate } from '@/lib/api-client';
import { isBatchInProgress, type SigningBatch, type SigningJob } from '@/lib/signing';
import { BatchStatusBadge } from './BatchStatusBadge';
import { DownloadButton } from './DownloadButton';

/** ถามสถานะซ้ำทุกกี่ ms ระหว่างรอ worker */
const POLL_INTERVAL_MS = 2000;
const PIN_PATTERN = /^\d{6,12}$/;

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

/**
 * ความคืบหน้าและผลของชุดการลงนาม (ไฟล์เดียวหรือ ZIP) — ถามสถานะซ้ำจนชุดจบ
 * จบแล้ว: ดาวน์โหลดทีละไฟล์/ทั้งชุดเป็น ZIP, รายการที่ข้าม, ลองใหม่เฉพาะไฟล์ที่ล้มเหลวชั่วคราว (ใส่ PIN อีกครั้ง)
 */
export function BatchProgress({ initial }: { initial: SigningBatch }) {
  const router = useRouter();
  const [batch, setBatch] = useState(initial);
  const inProgress = isBatchInProgress(batch.status);

  // ออกจากหน้า = หยุดถาม งานยังทำต่อที่ worker (กลับมาดูผลได้จากประวัติ)
  useEffect(() => {
    if (!inProgress) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { batch: latest } = await apiGet<{ batch: SigningBatch }>(`/me/signing-batches/${batch.id}`, controller.signal);
        setBatch(latest);
        if (!isBatchInProgress(latest.status)) {
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
  }, [batch.id, inProgress, router]);

  const total = batch.jobs.length;
  const signed = batch.jobs.filter((j) => j.status === 'signed').length;
  const failed = batch.jobs.filter((j) => j.status === 'failed').length;
  const finishedJobs = signed + failed;
  const filesAvailable = new Date(batch.expiresAt) > new Date();
  const zip = batch.source === 'zip';

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold break-all">
              {zip && <FileArchive className="size-5 shrink-0" aria-hidden />}
              {batch.zipName ?? batch.jobs[0]?.originalName ?? 'เอกสาร'}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {batch.lockDocument ? 'ล็อกเอกสารหลังลงนาม · ' : ''}
              {filesAvailable ? `ดาวน์โหลดได้ถึง ${dateFormatter.format(new Date(batch.expiresAt))}` : 'ไฟล์ถูกลบแล้ว (เก็บไว้ 7 วัน)'}
            </p>
          </div>
          <BatchStatusBadge status={batch.status} />
        </div>

        {batch.status === 'extracting' && (
          <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
            <LoaderCircle className="size-5 text-accent motion-safe:animate-spin" aria-hidden />
            กำลังตรวจและแตกไฟล์ ZIP...
          </p>
        )}
        {total > 0 && (
          <div className="space-y-2" aria-live="polite">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-neutral-soft"
              role="progressbar"
              aria-label="ความคืบหน้าการลงนาม"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={finishedJobs}
            >
              <div className="h-full bg-accent transition-[width]" style={{ width: `${(finishedJobs / total) * 100}%` }} />
            </div>
            <p className="text-sm text-muted tabular-nums">
              ลงนามแล้ว {signed}/{total} ไฟล์{failed > 0 ? ` · ไม่สำเร็จ ${failed} ไฟล์` : ''}
              {inProgress && batch.status === 'processing' ? ' · กำลังลงนาม...' : ''}
            </p>
          </div>
        )}

        {batch.error && (
          <Alert tone="danger" title="ลงนามทั้งชุดไม่สำเร็จ">
            {batch.error.message}
          </Alert>
        )}

        {!inProgress && signed > 0 && filesAvailable && (
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link href="/sign" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
              ลงนามไฟล์อื่น
            </Link>
            {zip ? (
              // ไฟล์ ZIP สร้างส่งตรงจาก API (ลิงก์ธรรมดา browser ดาวน์โหลดเองพร้อม cookie)
              <a
                href={`${process.env.NEXT_PUBLIC_API_URL}/me/signing-batches/${batch.id}/download`}
                className={buttonClasses({ fullWidth: true })}
              >
                ดาวน์โหลดทั้งหมด (ZIP)
              </a>
            ) : (
              batch.jobs[0]?.signedFileId && <DownloadButton fileId={batch.jobs[0].signedFileId} />
            )}
          </div>
        )}
      </section>

      {batch.canRetry && <RetryForm batchId={batch.id} onRetried={setBatch} />}

      {total > 0 && (zip || failed > 0) && (
        <section className="space-y-3" aria-labelledby="batch-files">
          <h2 id="batch-files" className="font-display text-lg font-semibold">
            ไฟล์ในชุด
          </h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-card">
            {batch.jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </section>
      )}

      {batch.skipped.length > 0 && (
        <section className="space-y-3" aria-labelledby="batch-skipped">
          <div>
            <h2 id="batch-skipped" className="font-display text-lg font-semibold">
              ไฟล์ที่ข้าม ({batch.skipped.length})
            </h2>
            <p className="text-sm text-muted">ไฟล์เหล่านี้ใน ZIP ไม่ได้ลงนาม</p>
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface shadow-card">
            {batch.skipped.map((s) => (
              <li key={s.name} className="flex items-start gap-3 p-4">
                <CircleSlash className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium break-all">{s.name}</span>
                  <span className="block text-sm text-muted">{s.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function JobRow({ job }: { job: SigningJob }) {
  const icon =
    job.status === 'signed' ? (
      <CircleCheck className="mt-0.5 size-5 shrink-0 text-success-fg" aria-label="ลงนามแล้ว" />
    ) : job.status === 'failed' ? (
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger-fg" aria-label="ไม่สำเร็จ" />
    ) : (
      <LoaderCircle className="mt-0.5 size-5 shrink-0 text-accent motion-safe:animate-spin" aria-label="กำลังลงนาม" />
    );
  return (
    <li className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        {icon}
        <span className="min-w-0">
          <span className="block text-sm font-medium break-all">{job.originalName}</span>
          {job.error && <span className="block text-sm text-danger-fg">{job.error.message}</span>}
        </span>
      </div>
      {job.signedFileId && <DownloadButton fileId={job.signedFileId} size="sm" />}
    </li>
  );
}

/** ลองใหม่เฉพาะส่วนที่ล้มเหลวชั่วคราว — ใส่ PIN อีกครั้ง (ยืนยัน 2026-10-25) */
function RetryForm({ batchId, onRetried }: { batchId: string; onRetried: (batch: SigningBatch) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!PIN_PATTERN.test(pin)) {
      setError('กรุณาใส่ PIN ลงนาม (ตัวเลข 6–12 หลัก)');
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const { batch } = await apiMutate<{ batch: SigningBatch }>(`/me/signing-batches/${batchId}/retry`, 'POST', { pin });
      setPin('');
      onRetried(batch);
    } catch (err) {
      setPin('');
      setError(err instanceof ApiClientError ? err.message : 'ลองใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4 rounded-xl border border-warning-line bg-warning-soft p-5 sm:p-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-warning-fg">บางส่วนไม่สำเร็จเพราะระบบขัดข้องชั่วคราว</h2>
        <p className="mt-1 text-sm text-warning-fg">ใส่ PIN เพื่อลงนามเฉพาะไฟล์ที่ไม่สำเร็จอีกครั้ง (ไฟล์ที่เสียหรือมีลายมือชื่ออยู่แล้วลองใหม่ไม่ได้)</p>
      </div>
      <TextField
        name="retryPin"
        label="PIN ลงนาม"
        type="password"
        inputMode="numeric"
        // new-password: กัน browser เติมรหัสผ่านที่บันทึกไว้ลงช่อง PIN
        autoComplete="new-password"
        maxLength={12}
        value={pin}
        onChange={(e) => setPin(e.target.value.trim())}
        error={error}
      />
      <div className="flex justify-end">
        <Button type="submit" fullWidth loading={submitting}>
          <RotateCcw className="size-5" aria-hidden />
          ลองใหม่
        </Button>
      </div>
    </form>
  );
}
