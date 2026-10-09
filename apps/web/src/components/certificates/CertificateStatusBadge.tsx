import { CircleCheck, CircleSlash, Clock, type LucideIcon } from 'lucide-react';
import { CERTIFICATE_STATUS_LABELS, type CertificateStatus } from '@/lib/certificate';

const STYLES: Record<CertificateStatus, { className: string; icon: LucideIcon }> = {
  active: { className: 'bg-green-50 text-green-800', icon: CircleCheck },
  expired: { className: 'bg-slate-100 text-slate-700', icon: Clock },
  revoked: { className: 'bg-red-50 text-red-800', icon: CircleSlash },
};

/** ป้ายสถานะใบรับรอง: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว) */
export function CertificateStatusBadge({ status }: { status: CertificateStatus }) {
  const { className, icon: Icon } = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="size-3.5" aria-hidden />
      {CERTIFICATE_STATUS_LABELS[status]}
    </span>
  );
}
