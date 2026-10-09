import Link from 'next/link';
import { Tag } from '@/components/UserStatusBadge';
import { ADMIN_REVOCATION_REASONS, type Certificate } from '@/lib/certificate';
import { CertificateStatusBadge } from './CertificateStatusBadge';
import { RevokeCertificateButton } from './RevokeCertificateButton';

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium' });

/**
 * การ์ดใบรับรองในหน้าผู้ดูแล — ปุ่มเพิกถอนแสดงเมื่อมี certificate:revoke และใบยังใช้งานอยู่
 * (ซ่อนเพื่อ UX เท่านั้น API ตรวจสิทธิ์และกฎเจ้าของใบอีกครั้ง)
 */
export function AdminCertificateCard({
  certificate: c,
  owner,
  canRevoke,
  canViewOwner,
}: {
  certificate: Certificate;
  /** undefined = ไม่ต้องแสดงเจ้าของ (อยู่ในหน้ารายละเอียดผู้ใช้อยู่แล้ว), null = ยังไม่มีเจ้าของ */
  owner?: { id: string; displayName: string } | null;
  canRevoke: boolean;
  /** มี user:read = ลิงก์ไปหน้ารายละเอียดเจ้าของได้ */
  canViewOwner: boolean;
}) {
  return (
    <li className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold break-words">{c.subjectCn || <span className="text-muted">(ลบข้อมูลแล้ว)</span>}</p>
          {c.email && <p className="text-sm break-all text-muted">{c.email}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {c.source === 'imported' && <Tag>นำเข้าจากระบบเดิม</Tag>}
          {c.hasKeyEscrow && <Tag>มี key สำรอง</Tag>}
          <CertificateStatusBadge status={c.status} />
        </div>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {owner !== undefined && (
          <>
            <dt className="text-muted">เจ้าของ</dt>
            <dd>
              {owner === null ? (
                <span className="text-muted">ยังไม่มีเจ้าของ (ผูกเมื่อเจ้าของอีเมลเข้าสู่ระบบ)</span>
              ) : canViewOwner ? (
                <Link href={`/admin/users/${owner.id}`} className="font-medium text-primary hover:underline">
                  {owner.displayName}
                </Link>
              ) : (
                owner.displayName
              )}
            </dd>
          </>
        )}
        <dt className="text-muted">ใช้ได้ตั้งแต่</dt>
        <dd className="tabular-nums">
          {dateFormatter.format(new Date(c.notBefore))} – {dateFormatter.format(new Date(c.notAfter))}
        </dd>
        {c.revokedAt && (
          <>
            <dt className="text-muted">เพิกถอนเมื่อ</dt>
            <dd className="tabular-nums">{dateFormatter.format(new Date(c.revokedAt))}</dd>
          </>
        )}
        <dt className="text-muted">หมายเลขใบรับรอง</dt>
        <dd className="font-mono text-xs break-all">{c.serialNumber}</dd>
      </dl>
      {canRevoke && c.status === 'active' && (
        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <RevokeCertificateButton
            endpoint={`/admin/certificates/${c.id}/revoke`}
            serialNumber={c.serialNumber}
            reasons={ADMIN_REVOCATION_REASONS}
            requireNote
          />
        </div>
      )}
    </li>
  );
}
