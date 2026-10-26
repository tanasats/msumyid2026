'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eraser, ImageUp, PenLine, Trash2 } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SegmentedControl } from '@/components/SegmentedControl';
import { ApiClientError, apiMutate, uploadToStorage } from '@/lib/api-client';
import { makeBackgroundTransparent } from '@/lib/signature-image';
import { MAX_SIGNATURE_IMAGE_BYTES, type SignatureImage } from '@/lib/signing';
import { formatBytes } from '@/lib/verify';

/** กระดาษขาว + หมึกน้ำเงินเข้มเสมอ (ภาพที่บันทึกพื้นโปร่งใส) — ไม่เปลี่ยนตามโหมดมืด */
const PAPER_STYLE = { backgroundColor: '#ffffff' } as const;
/** ตารางหมากรุกแสดงส่วนโปร่งใสของภาพ — เห็นได้ทันทีว่าภาพมีพื้นทึบที่จะบังเอกสารหรือไม่ */
const TRANSPARENCY_STYLE = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #e5e7eb 25%, transparent 25%), linear-gradient(-45deg, #e5e7eb 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e7eb 75%), linear-gradient(-45deg, transparent 75%, #e5e7eb 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
} as const;
/** ไฟล์ต้นฉบับที่อัปโหลดได้ — ระบบลบพื้น ตัดขอบ และย่อก่อนบันทึก (ผลลัพธ์ต้องไม่เกิน MAX_SIGNATURE_IMAGE_BYTES) */
const UPLOAD_TYPES = ['image/png', 'image/jpeg'];
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const INK = '#14286e';
/** ภาพที่บันทึกไม่เกินด้านละเท่านี้ (API รับถึง 2000 px) */
const MAX_OUTPUT_SIDE = 1200;

type Mode = 'draw' | 'upload';

/** ตัดขอบโปร่งใสรอบลายเซ็นออก (เหลือขอบ 8 px) แล้วย่อให้ไม่เกิน MAX_OUTPUT_SIDE — คืน PNG หรือ null ถ้ายังไม่ได้วาด */
async function trimmedPng(source: HTMLCanvasElement): Promise<Blob | null> {
  const ctx = source.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, source.width, source.height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  const sx = Math.max(0, minX - pad);
  const sy = Math.max(0, minY - pad);
  const sw = Math.min(width, maxX + pad + 1) - sx;
  const sh = Math.min(height, maxY + pad + 1) - sy;
  const scale = Math.min(1, MAX_OUTPUT_SIDE / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.max(16, Math.round(sw * scale));
  out.height = Math.max(16, Math.round(sh * scale));
  out.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
}

/**
 * ภาพที่อัปโหลด (PNG/JPEG) → PNG พื้นโปร่งใส ตัดขอบ และย่อแล้ว
 * ภาพสแกน/ถ่ายจากกระดาษมีพื้นขาวทึบ ถ้าไม่ลบจะบังข้อความในเอกสารตรงที่วางลายเซ็น
 */
async function preparedUpload(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (makeBackgroundTransparent(pixels.data, canvas.width, canvas.height)) ctx.putImageData(pixels, 0, 0);
  return trimmedPng(canvas);
}

/** พื้นที่วาดลายเซ็นด้วยเมาส์/นิ้ว/ปากกา (pointer events) — ความหนาเส้นตามแรงกดถ้าอุปกรณ์รองรับ */
function SignaturePad({ canvasRef, onDrawn }: { canvasRef: React.RefObject<HTMLCanvasElement | null>; onDrawn: () => void }) {
  const last = useRef<{ x: number; y: number } | null>(null);

  // ขนาด canvas = ขนาดที่แสดง × ความละเอียดจอ (เส้นคม)
  useEffect(() => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
  }, [canvasRef]);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = event.currentTarget.width / rect.width;
    return { x: (event.clientX - rect.left) * ratio, y: (event.clientY - rect.top) * ratio, ratio };
  }

  return (
    <canvas
      ref={canvasRef}
      aria-label="พื้นที่วาดลายเซ็น"
      className="block h-48 w-full cursor-crosshair touch-none rounded-lg border border-line-input sm:h-56"
      style={PAPER_STYLE}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const { x, y } = point(event);
        last.current = { x, y };
      }}
      onPointerMove={(event) => {
        if (!last.current) return;
        const { x, y, ratio } = point(event);
        const ctx = event.currentTarget.getContext('2d')!;
        ctx.strokeStyle = INK;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        // pressure 0.5 = อุปกรณ์ที่ไม่รู้แรงกด (เมาส์)
        ctx.lineWidth = (1.5 + 2.5 * (event.pressure || 0.5)) * ratio;
        ctx.beginPath();
        ctx.moveTo(last.current.x, last.current.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        last.current = { x, y };
        onDrawn();
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
    />
  );
}

/**
 * ตั้ง/เปลี่ยน/ลบภาพลายเซ็น: วาดบนจอ หรืออัปโหลด PNG/JPEG (ลบพื้นขาวให้โปร่งใสก่อนบันทึก)
 * บันทึก = ขอ URL อัปโหลด → PUT ตรงเข้า storage → ยืนยัน → PUT /me/signature-image (API ตรวจว่าเป็น PNG และขนาดภาพ)
 */
export function SignatureImageEditor({ image, onSaved }: { image: SignatureImage | null; onSaved?: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('draw');
  const [drawn, setDrawn] = useState(false);
  const [uploadFile, setUploadFile] = useState<{ name: string; png: Blob } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => void (uploadPreview && URL.revokeObjectURL(uploadPreview)), [uploadPreview]);

  function clearPad() {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setDrawn(false);
  }

  async function pickFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type)) return setError('กรุณาเลือกไฟล์ PNG หรือ JPEG');
    if (file.size > MAX_SOURCE_BYTES) return setError(`ไฟล์ต้องไม่เกิน ${formatBytes(MAX_SOURCE_BYTES)}`);
    setPreparing(true);
    try {
      const png = await preparedUpload(file);
      if (!png) return setError('ไม่พบลายเซ็นในภาพ');
      setUploadFile({ name: file.name, png });
      setUploadPreview(URL.createObjectURL(png));
    } catch (err) {
      console.error(err);
      setError('อ่านไฟล์ภาพไม่ได้ กรุณาเลือกไฟล์อื่น');
    } finally {
      setPreparing(false);
    }
  }

  async function save() {
    setError(null);
    const blob = mode === 'draw' ? await trimmedPng(canvasRef.current!) : (uploadFile?.png ?? null);
    if (!blob) return setError(mode === 'draw' ? 'กรุณาวาดลายเซ็นก่อนบันทึก' : 'กรุณาเลือกไฟล์ภาพ');
    if (blob.size > MAX_SIGNATURE_IMAGE_BYTES) return setError(`ภาพใหญ่เกิน ${formatBytes(MAX_SIGNATURE_IMAGE_BYTES)}`);
    setSaving(true);
    try {
      const upload = await apiMutate<{ file: { id: string }; uploadUrl: string }>('/me/files', 'POST', {
        purpose: 'signature_image',
        originalName: 'signature.png',
        mimeType: 'image/png',
        size: blob.size,
      });
      await uploadToStorage(upload.uploadUrl, blob, { contentType: 'image/png' });
      await apiMutate(`/me/files/${upload.file.id}/complete`, 'POST');
      await apiMutate('/me/signature-image', 'PUT', { fileId: upload.file.id });
      clearPad();
      setUploadFile(null);
      setUploadPreview(null);
      setSaved(true);
      router.refresh();
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'บันทึกภาพลายเซ็นไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {saved && <Alert tone="success">บันทึกภาพลายเซ็นแล้ว</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <section className="space-y-3 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <h2 className="font-display text-lg font-semibold">ภาพลายเซ็นปัจจุบัน</h2>
        {image ? (
          <>
            <div className="flex h-32 items-center justify-center rounded-lg border border-line p-3" style={TRANSPARENCY_STYLE}>
              {/* <img> ตรง ๆ: presigned URL ของ storage อายุสั้น */}
              <img src={image.url} alt="ภาพลายเซ็นของคุณ" className="max-h-full max-w-full object-contain" />
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="size-5" aria-hidden />
                ลบภาพลายเซ็น
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">
            ยังไม่ได้ตั้งภาพลายเซ็น — ลงนามแบบแสดงชื่อและวันเวลาได้โดยไม่ต้องมีภาพ
          </p>
        )}
      </section>

      <section className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div>
          <h2 className="font-display text-lg font-semibold">{image ? 'เปลี่ยนภาพลายเซ็น' : 'ตั้งภาพลายเซ็น'}</h2>
          <p className="mt-1 text-sm text-muted">ใช้ภาพเดียวกับทุกเอกสารที่ลงนาม ระบบเก็บไว้จนกว่าคุณจะเปลี่ยนหรือลบ</p>
        </div>
        <SegmentedControl<Mode>
          label="วิธีตั้งภาพลายเซ็น"
          value={mode}
          onChange={(value) => {
            setMode(value);
            setError(null);
          }}
          options={[
            { value: 'draw', label: 'วาดบนจอ', icon: PenLine },
            { value: 'upload', label: 'อัปโหลด PNG', icon: ImageUp },
          ]}
        />
        {mode === 'draw' ? (
          <div className="space-y-2">
            <SignaturePad canvasRef={canvasRef} onDrawn={() => !drawn && setDrawn(true)} />
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted">วาดด้วยเมาส์ นิ้ว หรือปากกา</p>
              <Button variant="ghost" size="sm" onClick={clearPad} disabled={!drawn}>
                <Eraser className="size-5" aria-hidden />
                ล้าง
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="flex min-h-24 cursor-pointer items-center gap-4 rounded-lg border-2 border-dashed border-line p-4 hover:bg-surface-hover">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-soft-fg">
                <ImageUp className="size-6" aria-hidden />
              </span>
              <span>
                <span className="block font-medium">
                  {preparing ? 'กำลังเตรียมภาพ...' : uploadFile ? uploadFile.name : 'เลือกไฟล์ PNG หรือ JPEG'}
                </span>
                <span className="block text-sm text-muted">
                  ภาพสแกนหรือถ่ายลายเซ็นบนกระดาษขาว — ระบบลบพื้นขาวให้โปร่งใสอัตโนมัติ ขนาดไม่เกิน {formatBytes(MAX_SOURCE_BYTES)}
                </span>
              </span>
              <input
                type="file"
                accept={UPLOAD_TYPES.join(',')}
                className="sr-only"
                disabled={preparing}
                onChange={(e) => void pickFile(e.target.files?.[0])}
              />
            </label>
            {uploadPreview && (
              <div className="flex h-32 items-center justify-center rounded-lg border border-line p-3" style={TRANSPARENCY_STYLE}>
                <img src={uploadPreview} alt="ตัวอย่างภาพที่เลือก (ลายตารางคือส่วนที่โปร่งใส)" className="max-h-full max-w-full object-contain" />
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button fullWidth loading={saving} onClick={() => void save()} disabled={mode === 'draw' ? !drawn : !uploadFile || preparing}>
            บันทึกภาพลายเซ็น
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="ลบภาพลายเซ็นหรือไม่?"
        description="เอกสารที่ลงนามไปแล้วไม่เปลี่ยน ลงนามครั้งต่อไปจะแสดงเฉพาะชื่อและวันเวลาจนกว่าจะตั้งภาพใหม่"
        confirmLabel="ลบภาพลายเซ็น"
        tone="danger"
        onConfirm={async () => {
          try {
            await apiMutate('/me/signature-image', 'DELETE');
          } catch (err) {
            throw new Error(err instanceof ApiClientError ? err.message : 'ลบภาพไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', { cause: err });
          }
          setConfirmDelete(false);
          setSaved(false);
          router.refresh();
        }}
      />
    </div>
  );
}
