import { CircleCheck, CircleSlash, Clock, ShieldX, type LucideIcon } from 'lucide-react';

type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_CLASSES: Record<BadgeTone, string> = {
  success: 'bg-green-50 text-green-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-800',
  neutral: 'bg-slate-100 text-slate-700',
};

/** สถานะบัญชีที่ผู้ใช้เห็น: ปิดบัญชีมาก่อนสถานะอนุมัติ (บัญชีที่ถูกปิดใช้งานไม่ได้ไม่ว่าจะอนุมัติหรือไม่) */
export function userStatus(user: { isActive: boolean; approvalStatus: 'pending' | 'approved' | 'rejected' }): {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
} {
  if (!user.isActive) return { label: 'ปิดบัญชี', tone: 'neutral', icon: CircleSlash };
  if (user.approvalStatus === 'pending') return { label: 'รออนุมัติ', tone: 'warning', icon: Clock };
  if (user.approvalStatus === 'rejected') return { label: 'ไม่อนุมัติ', tone: 'danger', icon: ShieldX };
  return { label: 'ใช้งานได้', tone: 'success', icon: CircleCheck };
}

/** ป้ายสถานะ: ไอคอน + ข้อความ + สี (ไม่สื่อด้วยสีอย่างเดียว) */
export function UserStatusBadge(props: { isActive: boolean; approvalStatus: 'pending' | 'approved' | 'rejected' }) {
  const { label, tone, icon: Icon } = userStatus(props);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/** ป้ายข้อความทั่วไป เช่น ประเภทบัญชี, role */
export function Tag({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        strong ? 'bg-primary-soft text-blue-800' : 'bg-slate-100 text-slate-700'
      }`}
    >
      {children}
    </span>
  );
}
