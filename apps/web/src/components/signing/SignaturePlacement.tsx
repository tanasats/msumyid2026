'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle, Move } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Button } from '@/components/Button';
import { openPdf, pageAspect, renderPage } from '@/lib/pdf-preview';
import { APPEARANCE_TEXT_SHARE, previewAppearanceLines, type SignatureBox, type SignatureImage } from '@/lib/signing';

/** หน้าเอกสารเป็นกระดาษขาวและตัวอักษรเข้มเสมอ (เหมือนใน PDF) ไม่เปลี่ยนตามโหมดมืด — สีข้อความตรงกับ rgb(0.12) ของ API */
const PAPER_STYLE = { backgroundColor: '#ffffff' } as const;
const INK = '#1f1f1f';

/** ขนาดเล็กสุดของกรอบ (สัดส่วนของหน้า) — API รับตั้งแต่ 0.02 */
const MIN_W = 0.08;
const MIN_H = 0.03;
/** ขยับด้วยแป้นลูกศรครั้งละ 1% ของหน้า */
const KEY_STEP = 0.01;

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * กรอบเริ่มต้น: กว้าง 30% ของหน้า สูงตามสัดส่วนภาพ (+ ส่วนข้อความ) วางมุมขวาล่างของหน้าแรก (ตัดสินใจ 2026-10-25)
 * aspect = สูง/กว้าง ของหน้าที่แสดงผล
 */
export function defaultSignatureBox(aspect: number, content: { image: SignatureImage | null; showText: boolean }): SignatureBox {
  const w = 0.3;
  let ratio = content.image ? content.image.height / content.image.width : 0.3;
  if (content.image && content.showText) ratio /= 1 - APPEARANCE_TEXT_SHARE;
  const h = clamp((w * ratio) / aspect, 0.04, 0.4);
  return { page: 1, x: 1 - w - 0.06, y: clamp(1 - h - 0.06, 0, 1 - h), w, h };
}

type Drag = { mode: 'move' | 'resize'; startX: number; startY: number; start: SignatureBox };

/**
 * แสดงหน้า PDF (pdf.js ในเครื่องผู้ใช้) พร้อมกรอบลายเซ็นที่ลากวางและย่อขยายได้ (เมาส์/นิ้ว/ปากกา) หรือใช้แป้นลูกศร
 * ตำแหน่งเก็บเป็นสัดส่วนของหน้าที่แสดงผล — ตรงกับที่ API แปลงเป็นพิกัด PDF (รวมหน้าที่หมุน)
 */
export function SignaturePlacement({
  file,
  box,
  onChange,
  image,
  showText,
  signerName,
}: {
  file: File;
  box: SignatureBox | null;
  onChange: (box: SignatureBox) => void;
  /** ภาพที่จะวาง (null = ข้อความอย่างเดียว) */
  image: SignatureImage | null;
  showText: boolean;
  signerName: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(true);
  /** สูง/กว้าง ของหน้าที่แสดงอยู่ (ใช้คำนวณขนาดตัวอักษรตัวอย่าง) */
  const [aspect, setAspect] = useState(1.414);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // ค่าที่ effect ใช้ตั้งกรอบเริ่มต้นครั้งเดียว — ไม่ใส่ใน dependency เพื่อไม่ให้รีเซ็ตกรอบเมื่อสลับภาพ/ข้อความ
  const initial = useRef({ box, image, showText, onChange });
  initial.current = { box, image, showText, onChange };

  const page = box?.page ?? 1;

  // เปิดไฟล์ใหม่ทุกครั้งที่เลือกไฟล์ แล้วตั้งกรอบเริ่มต้นจากขนาดหน้าแรก
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    openPdf(file)
      .then(async (pdf) => {
        opened = pdf;
        if (cancelled) return;
        const { box: current, image: img, showText: text, onChange: change } = initial.current;
        if (!current || current.page > pdf.numPages) change(defaultSignatureBox(await pageAspect(pdf, 1), { image: img, showText: text }));
        if (!cancelled) setDoc(pdf);
      })
      .catch(() => {
        if (!cancelled) setError('เปิดไฟล์เพื่อแสดงตัวอย่างไม่ได้ ไฟล์อาจเสียหรือตั้งรหัสผ่านไว้');
      });
    return () => {
      cancelled = true;
      void opened?.loadingTask.destroy();
    };
  }, [file]);

  // ความกว้างของพื้นที่แสดงผล (ปรับตามจอ)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // วาดหน้าที่เลือกใหม่เมื่อเปลี่ยนหน้า/ขนาด — ยกเลิกการวาดรอบก่อนที่ยังไม่เสร็จ
  useEffect(() => {
    if (!doc || !canvasRef.current || width === 0) return;
    const controller = new AbortController();
    setRendering(true);
    renderPage(doc, page, canvasRef.current, width, controller.signal)
      .then((rendered) => {
        if (rendered === null) return;
        setAspect(rendered);
        setRendering(false);
      })
      .catch(() => setError('แสดงหน้าเอกสารไม่ได้'));
    return () => controller.abort();
  }, [doc, page, width]);

  function update(next: Partial<SignatureBox>) {
    if (!box) return;
    const merged = { ...box, ...next };
    merged.w = clamp(merged.w, MIN_W, 1);
    merged.h = clamp(merged.h, MIN_H, 1);
    merged.x = clamp(merged.x, 0, 1 - merged.w);
    merged.y = clamp(merged.y, 0, 1 - merged.h);
    onChange(merged);
  }

  function startDrag(mode: Drag['mode']) {
    return (event: React.PointerEvent) => {
      if (!box) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
      drag.current = { mode, startX: event.clientX, startY: event.clientY, start: box };
    };
  }

  function onPointerMove(event: React.PointerEvent) {
    const d = drag.current;
    const rect = pageRef.current?.getBoundingClientRect();
    if (!d || !rect) return;
    const dx = (event.clientX - d.startX) / rect.width;
    const dy = (event.clientY - d.startY) / rect.height;
    if (d.mode === 'move') update({ x: d.start.x + dx, y: d.start.y + dy });
    else update({ w: clamp(d.start.w + dx, MIN_W, 1 - d.start.x), h: clamp(d.start.h + dy, MIN_H, 1 - d.start.y) });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!box) return;
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const [dx, dy] = delta.map((v) => v * KEY_STEP) as [number, number];
    // Shift + ลูกศร = ย่อ/ขยาย
    if (event.shiftKey) update({ w: box.w + dx, h: box.h + dy });
    else update({ x: box.x + dx, y: box.y + dy });
  }

  if (error) {
    return <p className="rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger-fg">{error}</p>;
  }

  const pageCount = doc?.numPages ?? 0;
  const lines = previewAppearanceLines(signerName);
  // ขนาดตัวอักษรตัวอย่าง: ให้ 2 บรรทัดพอดีส่วนข้อความ และไม่ล้นความกว้าง (ประมาณ 0.5 em ต่อตัวอักษร)
  const boxW = box ? box.w * width : 0;
  const boxH = box ? box.h * width * aspect : 0;
  const textH = showText ? (image ? boxH * APPEARANCE_TEXT_SHARE : boxH) : 0;
  const longest = Math.max(...lines.map((l) => l.length));
  const fontSize = Math.max(4, Math.min(textH / 2.5, (boxW * 0.96) / (longest * 0.5)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!box || page <= 1}
          onClick={() => update({ page: page - 1 })}
          aria-label="หน้าก่อนหน้า"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Button>
        <p className="text-sm tabular-nums text-muted" aria-live="polite">
          {pageCount > 0 ? `หน้า ${page} จาก ${pageCount}` : 'กำลังเปิดไฟล์...'}
        </p>
        <Button
          variant="secondary"
          size="sm"
          disabled={!box || page >= pageCount}
          onClick={() => update({ page: page + 1 })}
          aria-label="หน้าถัดไป"
        >
          <ChevronRight className="size-5" aria-hidden />
        </Button>
      </div>

      <div ref={containerRef} className="w-full">
        <div
          ref={pageRef}
          className="relative mx-auto w-fit overflow-hidden rounded-lg border border-line shadow-card"
          style={PAPER_STYLE}
        >
          <canvas ref={canvasRef} className="block" aria-label={`ตัวอย่างหน้า ${page} ของเอกสาร`} />
          {(rendering || !doc) && (
            <div className="absolute inset-0 flex min-h-48 items-center justify-center bg-surface/70">
              <LoaderCircle className="size-8 text-accent motion-safe:animate-spin" aria-hidden />
            </div>
          )}
          {box && doc && (
            <div
              role="slider"
              tabIndex={0}
              aria-label="ตำแหน่งลายเซ็น (ใช้ลูกศรเพื่อเลื่อน กด Shift ค้างเพื่อย่อหรือขยาย)"
              aria-valuetext={`ห่างจากซ้าย ${Math.round(box.x * 100)}% จากบน ${Math.round(box.y * 100)}%`}
              onPointerDown={startDrag('move')}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={onKeyDown}
              className="absolute flex cursor-move touch-none flex-col overflow-hidden rounded border-2 border-dashed border-accent bg-accent-soft/40 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent"
              style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }}
            >
              {image && (
                // <img> ตรง ๆ: presigned URL ของ storage อายุสั้น (next/image ต้องตั้ง remotePatterns และจะ cache URL)
                <img src={image.url} alt="" draggable={false} className="min-h-0 w-full flex-1 object-contain" />
              )}
              {showText && (
                <div
                  className="flex shrink-0 flex-col items-center justify-center leading-tight whitespace-nowrap"
                  style={{ height: image ? `${APPEARANCE_TEXT_SHARE * 100}%` : '100%', fontSize, color: INK }}
                >
                  <span>{lines[0]}</span>
                  <span>{lines[1]}</span>
                </div>
              )}
              {!image && !showText && <Move className="m-auto size-6 text-accent" aria-hidden />}
              {/* มุมขวาล่าง: ย่อ/ขยาย — พื้นที่แตะ 28px แสดงเป็นเส้นมุม ไม่บังเนื้อหาตัวอย่าง */}
              <span
                onPointerDown={startDrag('resize')}
                className="absolute right-0 bottom-0 size-7 cursor-nwse-resize touch-none after:absolute after:right-0.5 after:bottom-0.5 after:size-3 after:border-r-[3px] after:border-b-[3px] after:border-accent"
                aria-hidden
              />
            </div>
          )}
        </div>
      </div>
      <p className="text-sm text-muted">ลากกรอบเพื่อย้ายตำแหน่ง ลากมุมขวาล่างเพื่อย่อหรือขยาย</p>
    </div>
  );
}
