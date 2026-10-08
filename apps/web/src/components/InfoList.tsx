/** รายการ "หัวข้อ: ข้อมูล" — มือถือหัวข้ออยู่บน จอใหญ่อยู่ซ้าย */
export function InfoList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <dl className={`divide-y divide-line border-t border-line text-sm ${className}`}>{children}</dl>;
}

export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
      <dt className="text-muted sm:w-36 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}
