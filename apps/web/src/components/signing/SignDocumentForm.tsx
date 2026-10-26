'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleCheck, EyeOff, FileUp, LoaderCircle, Lock, PenLine, X } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { SegmentedControl } from '@/components/SegmentedControl';
import { TextField } from '@/components/TextField';
import { ApiClientError, apiMutate, uploadToStorage } from '@/lib/api-client';
import type { Certificate } from '@/lib/certificate';
import { formatBytes } from '@/lib/verify';
import {
  MAX_SIGNING_PDF_BYTES,
  MAX_SIGNING_ZIP_BYTES,
  type SignatureBox,
  type SignatureImage,
  type SigningBatch,
} from '@/lib/signing';
import { firstPdfInZip } from '@/lib/zip-preview';
import { SignaturePlacement } from './SignaturePlacement';
import { SigningPinForm } from './SigningPinForm';

const PIN_PATTERN = /^\d{6,12}$/;

const isZipFile = (f: File) =>
  ['application/zip', 'application/x-zip-compressed'].includes(f.type) || f.name.toLowerCase().endsWith('.zip');
const isPdfFile = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

/** ตัวอย่างสำหรับวางลายเซ็น: PDF = ไฟล์นั้น, ZIP = PDF ไฟล์แรกใน ZIP (null = ไม่พบ) */
type Preview = { status: 'none' } | { status: 'loading' } | { status: 'ready'; file: File } | { status: 'missing' };

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

type Step = { step: 'form' } | { step: 'uploading'; progress: number } | { step: 'submitting' };

type FieldErrors = Partial<Record<'file' | 'pin' | 'appearance', string>>;

type UploadResponse = { file: { id: string }; uploadUrl: string };

/**
 * ลงนาม PDF 1 ไฟล์ หรือหลายไฟล์ใน ZIP (ระยะ D3): อัปโหลดตรงเข้า storage → ส่งเข้าคิวพร้อม PIN → ไปหน้าผลการลงนาม
 * ZIP: วางลายเซ็นบนตัวอย่างจาก PDF ไฟล์แรก (อ่านบนเครื่องผู้ใช้) แล้วใช้ตำแหน่งเดียวกันกับทุกไฟล์
 * แสดงลายเซ็นบนเอกสาร (ภาพ + ชื่อ/วันเวลา ณ ตำแหน่งที่ลากวาง) หรือไม่แสดง (ลายมือชื่อดิจิทัลอย่างเดียว)
 * ยังไม่ตั้ง PIN = ให้ตั้งก่อนในหน้าเดียวกัน — ทุกขั้นตอน API ตรวจสิทธิ์ ไฟล์ ใบรับรอง และ PIN อีกครั้ง
 */
export function SignDocumentForm({
  certificates,
  hasPin: initialHasPin,
  signatureImage,
  signerName,
}: {
  certificates: Certificate[];
  hasPin: boolean;
  signatureImage: SignatureImage | null;
  /** ชื่อแสดง (display_name) — ใช้แสดงตัวอย่างข้อความใต้ลายเซ็น */
  signerName: string;
}) {
  const router = useRouter();
  const [hasPin, setHasPin] = useState(initialHasPin);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview>({ status: 'none' });
  const [certificateId, setCertificateId] = useState(certificates[0]?.id ?? '');
  const [lockDocument, setLockDocument] = useState(false);
  const [visible, setVisible] = useState(true);
  const [useImage, setUseImage] = useState(signatureImage !== null);
  const [showText, setShowText] = useState(true);
  const [box, setBox] = useState<SignatureBox | null>(null);
  const [pin, setPin] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<Step>({ step: 'form' });
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    const zip = isZipFile(picked);
    if (!zip && !isPdfFile(picked)) {
      setFieldErrors((e) => ({ ...e, file: 'กรุณาเลือกไฟล์ PDF หรือ ZIP ที่รวม PDF ไว้' }));
      return;
    }
    const max = zip ? MAX_SIGNING_ZIP_BYTES : MAX_SIGNING_PDF_BYTES;
    if (picked.size === 0 || picked.size > max) {
      setFieldErrors((e) => ({ ...e, file: `ไฟล์ต้องไม่ว่างและไม่เกิน ${formatBytes(max)}` }));
      return;
    }
    setFile(picked);
    // เลือกไฟล์ใหม่ = ตั้งกรอบเริ่มต้นใหม่ (มุมขวาล่างของหน้าแรก)
    setBox(null);
    setFieldErrors((e) => ({ ...e, file: undefined }));
    if (!zip) {
      setPreview({ status: 'ready', file: picked });
      return;
    }
    setPreview({ status: 'loading' });
    firstPdfInZip(picked).then(
      (pdf) => setPreview(pdf ? { status: 'ready', file: pdf } : { status: 'missing' }),
      () => setPreview({ status: 'missing' }),
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const errors: FieldErrors = {};
    if (!file) errors.file = 'กรุณาเลือกไฟล์ PDF หรือ ZIP ที่จะลงนาม';
    if (visible && !useImage && !showText) errors.appearance = 'เลือกแสดงภาพลายเซ็นหรือชื่อและวันเวลาอย่างน้อยหนึ่งอย่าง';
    else if (visible && file && !box) errors.appearance = 'ยังวางลายเซ็นบนเอกสารไม่ได้ (ไม่พบ PDF สำหรับแสดงตัวอย่าง) — เลือก "ไม่แสดง" หรือเลือกไฟล์อื่น';
    if (!PIN_PATTERN.test(pin)) errors.pin = 'กรุณาใส่ PIN ลงนาม (ตัวเลข 6–12 หลัก)';
    setFieldErrors(errors);
    if (errors.file) return document.getElementById('field-file')?.focus();
    if (errors.appearance) return document.getElementById('appearance-section')?.scrollIntoView({ block: 'center' });
    if (errors.pin) return document.getElementById('field-pin')?.focus();

    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setState({ step: 'uploading', progress: 0 });
    // Windows ส่งชนิด ZIP เป็น application/x-zip-compressed — ส่งชนิดมาตรฐานเสมอ (ต้องตรงกับที่ API เซ็นไว้ใน URL)
    const contentType = isZipFile(file!) ? 'application/zip' : 'application/pdf';
    try {
      const upload = await apiMutate<UploadResponse>('/me/files', 'POST', {
        purpose: 'signing_source',
        originalName: file!.name,
        mimeType: contentType,
        size: file!.size,
      });
      await uploadToStorage(upload.uploadUrl, file!, {
        contentType,
        signal: controller.signal,
        onProgress: (progress) => setState((s) => (s.step === 'uploading' ? { ...s, progress } : s)),
      });
      setState({ step: 'submitting' });
      await apiMutate(`/me/files/${upload.file.id}/complete`, 'POST');
      const { batch } = await apiMutate<{ batch: SigningBatch }>('/me/signing-batches', 'POST', {
        fileId: upload.file.id,
        certificateId,
        lockDocument,
        appearance:
          visible && box
            ? { visible: true, ...box, showText, useImage: useImage && signatureImage !== null }
            : { visible: false },
        pin,
      });
      setPin('');
      // ความคืบหน้าและผลอยู่ที่หน้าของชุด (ออกจากหน้าได้ worker ทำต่อ)
      router.push(`/sign/batches/${batch.id}`);
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

  if (state.step === 'submitting') {
    return (
      <section className="flex flex-col items-center rounded-xl border border-line bg-surface p-8 text-center shadow-card" aria-live="polite">
        <LoaderCircle className="size-10 text-accent motion-safe:animate-spin" aria-hidden />
        <h2 className="mt-4 font-display text-lg font-semibold">กำลังส่งเอกสารเข้าคิวลงนาม</h2>
      </section>
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
              <span className="block font-medium break-all">{file ? file.name : 'เลือกไฟล์ PDF หรือ ZIP'}</span>
              <span className="block text-sm text-muted">
                {file
                  ? formatBytes(file.size)
                  : `PDF 1 ไฟล์ (ไม่เกิน ${formatBytes(MAX_SIGNING_PDF_BYTES)}) หรือ ZIP ที่รวม PDF ไม่เกิน 100 ไฟล์ — ไฟล์ที่ผู้อื่นลงนามไว้แล้วก็ลงนามเพิ่มได้`}
              </span>
            </span>
          </label>
          <input
            ref={inputRef}
            id="field-file"
            type="file"
            accept="application/pdf,.pdf,application/zip,.zip"
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

      <section id="appearance-section" className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">2. ลายเซ็นบนเอกสาร</h2>
        <SegmentedControl<'visible' | 'invisible'>
          label="รูปแบบลายเซ็น"
          value={visible ? 'visible' : 'invisible'}
          onChange={(value) => setVisible(value === 'visible')}
          options={[
            { value: 'visible', label: 'แสดงลายเซ็น', icon: PenLine },
            { value: 'invisible', label: 'ไม่แสดง', icon: EyeOff },
          ]}
        />
        {visible ? (
          <>
            <div className="space-y-2">
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={useImage && signatureImage !== null}
                  disabled={!signatureImage}
                  onChange={(e) => setUseImage(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />
                <span className="text-sm">
                  <span className="block font-medium">แสดงภาพลายเซ็น</span>
                  <span className="block text-muted">
                    {signatureImage ? (
                      <Link href="/sign/signature" className="text-accent underline">
                        เปลี่ยนภาพลายเซ็น
                      </Link>
                    ) : (
                      <>
                        ยังไม่ได้ตั้งภาพ —{' '}
                        <Link href="/sign/signature" className="text-accent underline">
                          ตั้งภาพลายเซ็น
                        </Link>
                      </>
                    )}
                  </span>
                </span>
              </label>
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={showText}
                  onChange={(e) => setShowText(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />
                <span className="text-sm">
                  <span className="block font-medium">แสดงชื่อและวันเวลาที่ลงนาม</span>
                  <span className="block text-muted">ระบบสร้างจากชื่อในบัญชีและเวลาที่ลงนามจริง แก้ไขไม่ได้</span>
                </span>
              </label>
              {fieldErrors.appearance && (
                <p role="alert" className="text-sm text-danger-fg">
                  {fieldErrors.appearance}
                </p>
              )}
            </div>
            {preview.status === 'ready' ? (
              <>
                {file && isZipFile(file) && (
                  <p className="text-sm text-muted">
                    ตัวอย่างจาก <span className="font-medium break-all">{preview.file.name}</span> — ใช้ตำแหน่งเดียวกันกับทุกไฟล์ใน ZIP
                    (ไฟล์ที่ไม่มีหน้าที่เลือกจะลงนามไม่สำเร็จ)
                  </p>
                )}
                <SignaturePlacement
                  file={preview.file}
                  box={box}
                  onChange={setBox}
                  image={useImage ? signatureImage : null}
                  showText={showText}
                  signerName={signerName}
                />
              </>
            ) : preview.status === 'loading' ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <LoaderCircle className="size-5 text-accent motion-safe:animate-spin" aria-hidden />
                กำลังเปิด PDF ไฟล์แรกใน ZIP...
              </p>
            ) : preview.status === 'missing' ? (
              <p className="text-sm text-danger-fg">ไม่พบ PDF ใน ZIP สำหรับแสดงตัวอย่าง จึงวางลายเซ็นไม่ได้</p>
            ) : (
              <p className="text-sm text-muted">เลือกไฟล์ก่อน แล้วลากวางลายเซ็นบนหน้าเอกสารได้ที่นี่</p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">
            ลายมือชื่อดิจิทัลยังอยู่ในไฟล์และตรวจได้ใน Acrobat หรือหน้าตรวจสอบลายมือชื่อ แต่ไม่มีภาพบนหน้าเอกสาร
          </p>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">3. ใบรับรองและการล็อก</h2>
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
              Acrobat แสดงเป็นเอกสารรับรอง (Certified) ห้ามแก้ไขและห้ามผู้อื่นลงนามเพิ่ม — เลือกเมื่อเป็นฉบับสุดท้าย ล็อกได้เฉพาะไฟล์ที่ยังไม่มีลายมือชื่อ
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">4. ยืนยันด้วย PIN</h2>
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
