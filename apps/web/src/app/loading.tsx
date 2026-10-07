// skeleton ที่มีรูปร่างคล้ายหน้าจริง (header + การ์ด) แทน spinner กลางจอ — ดู docs/design/ui-guidelines.md หัวข้อ 5.5
export default function Loading() {
  return (
    <div role="status" aria-live="polite" className="min-h-dvh">
      <span className="sr-only">กำลังโหลด...</span>
      <div aria-hidden className="motion-safe:animate-pulse">
        <div className="h-14 border-b border-line bg-surface" />
        <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 md:px-6 lg:px-8">
          <div className="h-7 w-48 rounded-md bg-slate-200" />
          <div className="h-32 rounded-xl bg-slate-200" />
          <div className="h-20 rounded-xl bg-slate-200" />
          <div className="h-20 rounded-xl bg-slate-200" />
        </div>
      </div>
    </div>
  );
}
