import Link from 'next/link';
import { Tag } from '@/components/UserStatusBadge';
import { ACCOUNT_TYPE_LABELS } from '@/lib/account-type';
import type { AdminPrimaryRequest } from '@/lib/primary-certificate-request';
import { PrimaryDecisionButtons } from './PrimaryDecisionButtons';
import { SupplementaryStatusBadge } from './SupplementaryStatusBadge';

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

/** คำขอใบรับรองประจำตัวในหน้าผู้อนุมัติ — คำขอที่รออนุมัติมีปุ่มอนุมัติ/ไม่อนุมัติ, canViewRequester = มี user:read */
export function AdminPrimaryRequestCard({
  request,
  canViewRequester,
}: {
  request: AdminPrimaryRequest;
  canViewRequester: boolean;
}) {
  const requesterName = request.requester?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว';

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
          <SupplementaryStatusBadge status={request.status} />
        </div>
      </div>

      <p className="mt-3 break-words">{request.purpose ?? <span className="text-muted">ไม่ได้ระบุวัตถุประสงค์</span>}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
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
          <PrimaryDecisionButtons requestId={request.id} requesterName={requesterName} />
        </div>
      )}
    </li>
  );
}
