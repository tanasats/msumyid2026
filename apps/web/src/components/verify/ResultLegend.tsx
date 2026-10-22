import { ShieldCheck, ShieldQuestionMark, ShieldX, type LucideIcon } from 'lucide-react';

type Level = { icon: LucideIcon; tone: string; title: string; detail: string };

// ไอคอนและสีเดียวกับป้ายผลใน SignatureResultCard — ผู้ใช้เห็นคำอธิบายกับผลจริงแล้วจับคู่ได้ทันที
const LEVELS: Level[] = [
  {
    icon: ShieldCheck,
    tone: 'bg-success-soft text-success-fg',
    title: 'ลายมือชื่อถูกต้อง',
    detail: 'เอกสารไม่ถูกแก้ไขหลังลงนาม และใบรับรองของผู้ลงนามออกโดยหน่วยงานที่ระบบเชื่อถือ ใช้งานได้ ณ เวลาลงนาม',
  },
  {
    icon: ShieldQuestionMark,
    tone: 'bg-warning-soft text-warning-fg',
    title: 'ไม่ทราบความถูกต้อง',
    detail:
      'เอกสารไม่ถูกแก้ไข แต่ระบบยืนยันตัวตนผู้ลงนามไม่ได้ เช่น ใบรับรองออกโดยหน่วยงานที่ระบบยังไม่รู้จัก หรือตรวจการเพิกถอนไม่ได้',
  },
  {
    icon: ShieldX,
    tone: 'bg-danger-soft text-danger-fg',
    title: 'ลายมือชื่อไม่ถูกต้อง',
    detail: 'เอกสารถูกแก้ไขหลังลงนาม หรือใบรับรองถูกเพิกถอน/หมดอายุก่อนลงนาม — ไม่ควรเชื่อถือเอกสารนี้',
  },
];

/** ความหมายของผลการตรวจ 3 ระดับ — ใช้ในหน้า /verify และหน้าแลนดิ้ง */
export function ResultLegend({ className = '' }: { className?: string }) {
  return (
    <dl className={`space-y-4 ${className}`}>
      {LEVELS.map(({ icon: Icon, tone, title, detail }) => (
        <div key={title} className="flex gap-3">
          <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${tone}`}>
            <Icon className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <dt className="font-semibold">{title}</dt>
            <dd className="leading-relaxed text-muted">{detail}</dd>
          </div>
        </div>
      ))}
    </dl>
  );
}
