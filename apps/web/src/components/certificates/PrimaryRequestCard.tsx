import Link from 'next/link';
import { Download } from 'lucide-react';
import { buttonClasses } from '@/components/Button';
import type { PrimaryRequest } from '@/lib/primary-certificate-request';
import { CancelSupplementaryRequestButton } from './CancelSupplementaryRequestButton';
import { SupplementaryStatusBadge } from './SupplementaryStatusBadge';

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

/**
 * คำขอใบรับรองประจำตัวของผู้ใช้: สถานะ ผลการพิจารณา และปุ่มรับใบ/ยกเลิก
 * canAct = มี certificate:apply (ซ่อนปุ่มเพื่อ UX เท่านั้น API ตรวจอีกครั้ง)
 * ใช้ป้ายสถานะเดียวกับคำขอใบเสริม (สถานะชุดเดียวกัน)
 */
export function PrimaryRequestCard({ request, canAct }: { request: PrimaryRequest; canAct: boolean }) {
  const cancellable = request.status === 'pending' || request.status === 'approved';

  return (
    <li className="rounded-xl border border-line bg-surface shadow-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-semibold break-words">{request.purpose ?? 'คำขอใบรับรองประจำตัว'}</p>
        <SupplementaryStatusBadge status={request.status} />
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
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
        {request.status === 'approved' && request.claimableUntil && (
          <>
            <dt className="text-muted">รับใบได้ถึง</dt>
            <dd className="font-medium tabular-nums">{dateFormatter.format(new Date(request.claimableUntil))}</dd>
          </>
        )}
        {request.decisionNote && (
          <>
            <dt className="text-muted">{request.status === 'rejected' ? 'เหตุผล' : 'บันทึกจากผู้อนุมัติ'}</dt>
            <dd className="break-words">{request.decisionNote}</dd>
          </>
        )}
      </dl>
      {request.status === 'expired' && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-muted">
          ไม่ได้รับใบภายใน 30 วันหลังอนุมัติ ถ้ายังต้องการใบรับรอง กรุณาส่งคำขอใหม่
        </p>
      )}
      {canAct && cancellable && (
        <div className="mt-4 flex flex-col-reverse gap-3 border-t border-line pt-4 sm:flex-row sm:justify-end">
          <CancelSupplementaryRequestButton requestId={request.id} basePath="/me/primary-certificate-requests" />
          {request.status === 'approved' && (
            <Link href={`/certificates/requests/${request.id}/claim`} className={buttonClasses({ size: 'sm', fullWidth: true })}>
              <Download className="size-4" aria-hidden />
              รับใบรับรอง
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
