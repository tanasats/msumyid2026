import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

// พื้นอ่อน + ตัวอักษรเข้ม (contrast ≥ 6.8:1) + ไอคอน — ไม่สื่อด้วยสีอย่างเดียว
const TONES: Record<AlertTone, { box: string; icon: LucideIcon }> = {
  info: { box: 'border-info-line bg-info-soft text-info-fg', icon: Info },
  success: { box: 'border-success-line bg-success-soft text-success-fg', icon: CircleCheck },
  warning: { box: 'border-warning-line bg-warning-soft text-warning-fg', icon: TriangleAlert },
  danger: { box: 'border-danger-line bg-danger-soft text-danger-fg', icon: CircleAlert },
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
