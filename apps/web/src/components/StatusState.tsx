import type { LucideIcon } from 'lucide-react';

type StatusTone = 'neutral' | 'info' | 'warning' | 'danger';

const ICON_TONES: Record<StatusTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  info: 'bg-blue-50 text-blue-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-800',
};

/**
 * สถานะทั้งหน้า/ทั้งส่วน: ว่าง (empty), error, ไม่มีสิทธิ์, รออนุมัติ ฯลฯ
 * รูปแบบ: ไอคอน + หัวข้อ + คำอธิบาย + ปุ่มให้ทำขั้นต่อไป
 */
export function StatusState({
  icon: Icon,
  tone = 'neutral',
  title,
  headingLevel = 'h2',
  children,
  action,
}: {
  icon: LucideIcon;
  tone?: StatusTone;
  title: string;
  /** ใช้ h1 เมื่อเป็นเนื้อหาหลักของหน้า */
  headingLevel?: 'h1' | 'h2';
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Heading = headingLevel;
  return (
    <section className="mx-auto flex max-w-md flex-col items-center px-2 py-10 text-center">
      <div className={`flex size-16 items-center justify-center rounded-full ${ICON_TONES[tone]}`}>
        <Icon className="size-8" aria-hidden />
      </div>
      <Heading className="mt-4 text-xl font-semibold text-fg">{title}</Heading>
      {children && <div className="mt-2 leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-6 flex w-full flex-col-reverse gap-3 sm:w-auto sm:flex-row">{action}</div>}
    </section>
  );
}
