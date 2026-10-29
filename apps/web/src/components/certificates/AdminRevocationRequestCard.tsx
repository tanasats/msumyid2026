import Link from 'next/link';
import { Ban, CircleSlash, Clock, ShieldX, type LucideIcon } from 'lucide-react';
import { Tag } from '@/components/UserStatusBadge';
import { ACCOUNT_TYPE_LABELS } from '@/lib/account-type';
import { SELF_REVOCATION_REASONS } from '@/lib/certificate';
import {
  REVOCATION_REQUEST_STATUS_LABELS,
  type AdminRevocationRequest,
  type RevocationRequestStatus,
} from '@/lib/certificate-revocation-request';
import { RevocationDecisionButtons } from './RevocationDecisionButtons';

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

const STATUS_STYLES: Record<RevocationRequestStatus, { className: string; icon: LucideIcon }> = {
  pending: { className: 'bg-warning-soft text-warning-fg', icon: Clock },
  approved: { className: 'bg-danger-soft text-danger-fg', icon: Ban },
  rejected: { className: 'bg-neutral-soft text-neutral-fg', icon: ShieldX },
  cancelled: { className: 'bg-neutral-soft text-neutral-fg', icon: CircleSlash },
};

/** ป้ายสถานะคำขอเพิกถอน: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว) */
function RevocationRequestStatusBadge({ status }: { status: RevocationRequestStatus }) {
  const { className, icon: Icon } = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      <Icon className="size-3.5" aria-hidden />
      {REVOCATION_REQUEST_STATUS_LABELS[status]}
    </span>
  );
}

/** คำขอเพิกถอนในหน้าผู้อนุมัติ — คำขอที่รออนุมัติมีปุ่มอนุมัติ/ไม่อนุมัติ, canViewRequester = มี user:read */
export function AdminRevocationRequestCard({
  request,
  canViewRequester,
}: {
  request: AdminRevocationRequest;
  canViewRequester: boolean;
}) {
  const requesterName = request.requester?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว';
  const reasonLabel = SELF_REVOCATION_REASONS.find((r) => r.value === request.reason)?.label ?? request.reason;

  return (
    <li className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {request.requester && canViewRequester ? (
            <Link
              href={`/admin/users/${request.requester.id}`}
              className="font-semibold break-words text-accent-soft-fg underline-offset-2 hover:underline"
            >
              {requesterName}
            </Link>
          ) : (
            <p className="font-semibold break-words">{requesterName}</p>
          )}
          {request.requester && <p className="text-sm break-all text-muted">{request.requester.email}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {request.requester && <Tag>{ACCOUNT_TYPE_LABELS[request.requester.accountType]}</Tag>}
          <RevocationRequestStatusBadge status={request.status} />
        </div>
      </div>

      <p className="mt-3 break-words">{reasonLabel}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">หมายเลขใบรับรอง</dt>
        <dd className="font-mono text-xs break-all">{request.certificate.serialNumber}</dd>
        <dt className="text-muted">หมดอายุ</dt>
        <dd className="tabular-nums">{dateFormatter.format(new Date(request.certificate.notAfter))}</dd>
        <dt className="text-muted">ส่งคำขอเมื่อ</dt>
        <dd className="tabular-nums">{dateTimeFormatter.format(new Date(request.createdAt))}</dd>
        {request.decidedAt && (
          <>
            <dt className="text-muted">ผู้พิจารณา</dt>
            <dd>
              {request.decidedBy?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'}
              <span className="text-muted tabular-nums"> · {dateTimeFormatter.format(new Date(request.decidedAt))}</span>
            </dd>
          </>
        )}
        {request.decisionNote && (
          <>
            <dt className="text-muted">{request.status === 'rejected' ? 'เหตุผล' : 'บันทึก'}</dt>
            <dd className="break-words">{request.decisionNote}</dd>
          </>
        )}
      </dl>

      {request.status === 'pending' && request.requester && (
        <div className="mt-4 flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:justify-end">
          <RevocationDecisionButtons
            requestId={request.id}
            requesterName={requesterName}
            serialNumber={request.certificate.serialNumber}
          />
        </div>
      )}
    </li>
  );
}
