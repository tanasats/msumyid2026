import Link from 'next/link';
import { Download } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import { formatRange, type SupplementaryRequest } from '@/lib/supplementary-certificate';
import { CancelSupplementaryRequestButton } from './CancelSupplementaryRequestButton';
import { SupplementaryStatusBadge } from './SupplementaryStatusBadge';

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

/**
 * คำขอใบเสริมของผู้ใช้: ช่วงที่ขอ/ที่อนุมัติ ผลการพิจารณา และปุ่มรับใบ/ยกเลิก
 * canAct = มี supplementary_certificate:request (ซ่อนปุ่มเพื่อ UX เท่านั้น API ตรวจอีกครั้ง)
 */
export function SupplementaryRequestCard({ request, canAct }: { request: SupplementaryRequest; canAct: boolean }) {
  const approvedChanged =
    request.approvedStart !== null &&
    (request.approvedStart !== request.requestedStart || request.approvedEnd !== request.requestedEnd);
  const cancellable = request.status === 'pending' || request.status === 'approved';

  return (
    <li className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-semibold break-words">{request.purpose}</p>
        <SupplementaryStatusBadge status={request.status} />
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">{approvedChanged ? 'ช่วงที่ขอ' : 'ช่วงที่ใช้'}</dt>
        <dd className="tabular-nums">{formatRange(request.requestedStart, request.requestedEnd)}</dd>
        {approvedChanged && (
          <>
            <dt className="text-muted">ช่วงที่อนุมัติ</dt>
            <dd className="font-medium tabular-nums">{formatRange(request.approvedStart!, request.approvedEnd!)}</dd>
          </>
        )}
        <dt className="text-muted">ส่งคำขอเมื่อ</dt>
        <dd className="tabular-nums">{dateFormatter.format(new Date(request.createdAt))}</dd>
        {request.decidedAt && (
          <>
            <dt className="text-muted">{request.status === 'rejected' ? 'ไม่อนุมัติโดย' : 'อนุมัติโดย'}</dt>
            <dd>
              {request.decidedBy?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'}
              <span className="text-muted tabular-nums"> · {dateFormatter.format(new Date(request.decidedAt))}</span>
            </dd>
          </>
        )}
        {request.decisionNote && (
          <>
            <dt className="text-muted">{request.status === 'rejected' ? 'เหตุผล' : 'บันทึกจากผู้อนุมัติ'}</dt>
            <dd className="break-words">{request.decisionNote}</dd>
          </>
        )}
      </dl>
      {request.status === 'issued' && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-muted">ใบรับรองจากคำขอนี้อยู่ในรายการใบรับรองด้านบน หรือในประวัติเมื่อหมดอายุ</p>
      )}
      {request.status === 'expired' && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
          เลยวันสิ้นสุดแล้วยังไม่ได้รับใบ ถ้ายังต้องใช้ กรุณาส่งคำขอใหม่
        </p>
      )}
      {canAct && cancellable && (
        <div className="mt-4 flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:justify-end">
          <CancelSupplementaryRequestButton requestId={request.id} />
          {request.status === 'approved' && (
            <Link
              href={`/certificates/supplementary/${request.id}/claim`}
              className={buttonClasses({ size: 'sm', fullWidth: true })}
            >
              <Download className="size-4" aria-hidden />
              รับใบรับรอง
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
