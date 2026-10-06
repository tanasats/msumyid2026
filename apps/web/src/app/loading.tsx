export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center" role="status" aria-live="polite">
      <div className="size-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-600" />
      <span className="sr-only">กำลังโหลด...</span>
    </div>
  );
}
