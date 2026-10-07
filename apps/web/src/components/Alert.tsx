import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

// พื้นอ่อน + ตัวอักษรเข้ม (contrast ≥ 6.8:1) + ไอคอน — ไม่สื่อด้วยสีอย่างเดียว
const TONES: Record<AlertTone, { box: string; icon: LucideIcon }> = {
  info: { box: 'border-blue-200 bg-blue-50 text-blue-800', icon: Info },
  success: { box: 'border-green-200 bg-green-50 text-green-800', icon: CircleCheck },
  warning: { box: 'border-amber-200 bg-amber-50 text-amber-800', icon: TriangleAlert },
  danger: { box: 'border-red-200 bg-red-50 text-red-800', icon: CircleAlert },
};

/**
 * กล่องข้อความแจ้งในหน้า (inline alert) — ไม่หายเอง
 * danger/warning ใช้ role="alert" ให้โปรแกรมอ่านหน้าจออ่านทันที
 */
export function Alert({
  tone = 'info',
  title,
  children,
  className = '',
}: {
  tone?: AlertTone;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = TONES[tone];
  const urgent = tone === 'danger' || tone === 'warning';

  return (
    <div role={urgent ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border p-3 text-sm ${box} ${className}`}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
