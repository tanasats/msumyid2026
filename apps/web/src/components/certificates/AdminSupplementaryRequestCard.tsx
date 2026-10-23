import Link from 'next/link';
import { Tag } from '@/components/UserStatusBadge';
import { ACCOUNT_TYPE_LABELS } from '@/lib/account-type';
import { formatRange, type AdminSupplementaryRequest, type SupplementaryLimits } from '@/lib/supplementary-certificate';
import { SupplementaryDecisionButtons } from './SupplementaryDecisionButtons';
import { SupplementaryStatusBadge } from './SupplementaryStatusBadge';

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

/**
 * คำขอใบเสริมในหน้าผู้อนุมัติ: ผู้ขอ วัตถุประสงค์ ช่วงวันที่ และผลการพิจารณา
 * คำขอที่รออนุมัติมีปุ่มอนุมัติ/ไม่อนุมัติ — canViewRequester = มี user:read (ลิงก์ไปหน้าผู้ใช้)
 */
export function AdminSupplementaryRequestCard({
  request,
  limits,
  canViewRequester,
}: {
  request: AdminSupplementaryRequest;
  limits: Pick<SupplementaryLimits, 'maxDays' | 'maxLeadDays' | 'today'>;
  canViewRequester: boolean;
}) {
  const requesterName = request.requester?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว';
  const approvedChanged =
    request.approvedStart !== null &&
    (request.approvedStart !== request.requestedStart || request.approvedEnd !== request.requestedEnd);

  return (
    <li className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {request.requester && canViewRequester ? (
            <Link href={`/admin/users/${request.requester.id}`} className="font-semibold break-words text-accent-soft-fg underline-offset-2 hover:underline">
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

      <p className="mt-3 break-words">{request.purpose}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">ช่วงที่ขอ</dt>
        <dd className="tabular-nums">{formatRange(request.requestedStart, request.requestedEnd)}</dd>
        {approvedChanged && (
          <>
            <dt className="text-muted">ช่วงที่อนุมัติ</dt>
            <dd className="font-medium tabular-nums">{formatRange(request.approvedStart!, request.approvedEnd!)}</dd>
          </>
        )}
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
          <SupplementaryDecisionButtons request={request} requesterName={requesterName} limits={limits} />
        </div>
      )}
    </li>
  );
}
