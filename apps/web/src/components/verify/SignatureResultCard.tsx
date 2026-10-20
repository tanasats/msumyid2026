import { CircleAlert, Info, ShieldCheck, ShieldQuestionMark, ShieldX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { InfoList, InfoRow } from '@/components/InfoList';
import {
  INTEGRITY_LABELS,
  REVOCATION_LABELS,
  REVOCATION_REASON_LABELS,
  VERDICT_LABELS,
  type Finding,
  type SignatureReport,
  type Verdict,
} from '@/lib/verify';

const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Bangkok' });
const dateOnly = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

// สถานะ: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว — docs/design/ui-guidelines.md)
const VERDICT_STYLES: Record<Verdict, { badge: string; icon: LucideIcon }> = {
  valid: { badge: 'bg-success-soft text-success-fg', icon: ShieldCheck },
  unknown: { badge: 'bg-warning-soft text-warning-fg', icon: ShieldQuestionMark },
  invalid: { badge: 'bg-danger-soft text-danger-fg', icon: ShieldX },
};

const FINDING_STYLES: Record<Finding['level'], { className: string; icon: LucideIcon }> = {
  error: { className: 'text-danger-fg', icon: CircleAlert },
  warning: { className: 'text-warning-fg', icon: TriangleAlert },
  info: { className: 'text-muted', icon: Info },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { badge, icon: Icon } = VERDICT_STYLES[verdict];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${badge}`}>
      <Icon className="size-4" aria-hidden />
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

function formatDate(value: string | null, formatter = dateTime): string {
  return value ? formatter.format(new Date(value)) : '-';
}

export function SignatureResultCard({ report, total }: { report: SignatureReport; total: number }) {
  const signer = report.signer;
  const isTimestamp = report.kind === 'document_timestamp';
  const title = isTimestamp
    ? 'การประทับเวลาเอกสาร'
    : (signer?.commonName ?? signer?.organization ?? 'ไม่ทราบชื่อผู้ลงนาม');

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {total > 1 && (
            <p className="text-xs font-medium text-muted">
              ลายมือชื่อที่ {report.index + 1} จาก {total}
            </p>
          )}
          <h3 className="font-display text-lg font-semibold break-words">{title}</h3>
          {signer?.organization && signer.commonName && <p className="text-sm text-muted">{signer.organization}</p>}
        </div>
        <div className="shrink-0">
          <VerdictBadge verdict={report.verdict} />
        </div>
      </div>

      {report.issuedByUniversity && (
        <p className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-soft-fg">
          <ShieldCheck className="size-3.5" aria-hidden />
          ใบรับรองของมหาวิทยาลัยมหาสารคาม
        </p>
      )}

      {report.findings.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm">
          {report.findings.map((finding, i) => {
            const { className, icon: Icon } = FINDING_STYLES[finding.level];
            return (
              <li key={i} className={`flex gap-2 ${className}`}>
                <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{finding.message}</span>
              </li>
            );
          })}
        </ul>
      )}

      <InfoList className="mt-4">
        {!isTimestamp && signer?.email && <InfoRow label="อีเมล">{signer.email}</InfoRow>}
        <InfoRow label={isTimestamp ? 'เวลาที่ประทับ' : 'เวลาลงนาม'}>
          {formatDate(report.signingTime.value)}
          {report.signingTime.source === 'timestamp' && (
            <span className="block text-xs text-muted">รับรองโดยหน่วยประทับเวลา {report.timestamp.authority}</span>
          )}
          {report.signingTime.source === 'claimed' && (
            <span className="block text-xs text-muted">เวลาจากเครื่องของผู้ลงนาม (ไม่ได้รับรองโดยหน่วยประทับเวลา)</span>
          )}
        </InfoRow>
        {report.reason && <InfoRow label="เหตุผล">{report.reason}</InfoRow>}
        {report.location && <InfoRow label="สถานที่">{report.location}</InfoRow>}
        <InfoRow label="ความครบถ้วน">
          {INTEGRITY_LABELS[report.integrity]}
          {report.integrity === 'ok' && !report.coversWholeDocument && (
            <span className="block text-xs text-muted">มีการเพิ่มเติมเอกสารหลังลายมือชื่อนี้</span>
          )}
        </InfoRow>
        <InfoRow label="ผู้ออกใบรับรอง">
          {report.chain.status === 'trusted' ? (
            <>
              {report.chain.path[1]?.subject ?? signer?.issuer}
              <span className="block text-xs text-muted">ภายใต้ {report.chain.anchor} (ระบบเชื่อถือ)</span>
            </>
          ) : (
            <>
              {signer?.issuer ?? '-'}
              <span className="block text-xs text-muted">ไม่อยู่ในรายชื่อที่ระบบเชื่อถือ</span>
            </>
          )}
        </InfoRow>
        {!isTimestamp && (
          <InfoRow label="การเพิกถอน">
            {REVOCATION_LABELS[report.revocation.status]}
            {report.revocation.revokedAt && (
              <span className="block text-xs text-muted">
                เพิกถอนเมื่อ {formatDate(report.revocation.revokedAt)}
                {report.revocation.reason && ` — ${REVOCATION_REASON_LABELS[report.revocation.reason] ?? report.revocation.reason}`}
              </span>
            )}
          </InfoRow>
        )}
        {signer && (
          <InfoRow label="อายุใบรับรอง">
            <span className="tabular-nums">
              {formatDate(signer.notBefore, dateOnly)} – {formatDate(signer.notAfter, dateOnly)}
            </span>
          </InfoRow>
        )}
        {signer && (
          <InfoRow label="Serial">
            <span className="font-mono text-xs break-all">{signer.serialNumber}</span>
          </InfoRow>
        )}
      </InfoList>
    </section>
  );
}
