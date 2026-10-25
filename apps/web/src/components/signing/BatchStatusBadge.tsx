import { CircleAlert, CircleCheck, LoaderCircle, type LucideIcon } from 'lucide-react';
import { BATCH_STATUS_LABELS, type SigningBatchStatus } from '@/lib/signing';

const STYLES: Record<SigningBatchStatus, { className: string; icon: LucideIcon }> = {
  extracting: { className: 'bg-info-soft text-info-fg', icon: LoaderCircle },
  processing: { className: 'bg-info-soft text-info-fg', icon: LoaderCircle },
  completed: { className: 'bg-success-soft text-success-fg', icon: CircleCheck },
  failed: { className: 'bg-danger-soft text-danger-fg', icon: CircleAlert },
};

/** ป้ายสถานะการลงนาม: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว) */
export function BatchStatusBadge({ status }: { status: SigningBatchStatus }) {
  const { className, icon: Icon } = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="size-3.5" aria-hidden />
      {BATCH_STATUS_LABELS[status]}
    </span>
  );
}
