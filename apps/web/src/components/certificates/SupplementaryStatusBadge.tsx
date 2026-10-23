import { CircleCheck, CircleSlash, Clock, Download, ShieldX, TimerOff, type LucideIcon } from 'lucide-react';
import { SUPPLEMENTARY_STATUS_LABELS, type SupplementaryRequestStatus } from '@/lib/supplementary-certificate';

const STYLES: Record<SupplementaryRequestStatus, { className: string; icon: LucideIcon }> = {
  pending: { className: 'bg-warning-soft text-warning-fg', icon: Clock },
  approved: { className: 'bg-accent-soft text-accent-soft-fg', icon: Download },
  issued: { className: 'bg-success-soft text-success-fg', icon: CircleCheck },
  rejected: { className: 'bg-danger-soft text-danger-fg', icon: ShieldX },
  cancelled: { className: 'bg-neutral-soft text-neutral-fg', icon: CircleSlash },
  expired: { className: 'bg-neutral-soft text-neutral-fg', icon: TimerOff },
};

/** ป้ายสถานะคำขอใบเสริม: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว) */
export function SupplementaryStatusBadge({ status }: { status: SupplementaryRequestStatus }) {
  const { className, icon: Icon } = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="size-3.5" aria-hidden />
      {SUPPLEMENTARY_STATUS_LABELS[status]}
    </span>
  );
}
