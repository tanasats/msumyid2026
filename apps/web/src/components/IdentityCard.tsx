import { Avatar } from './Avatar';
import { MsuMark } from './BrandLogo';
import { SecurityPattern } from './SecurityPattern';

type IdentityCardProps = {
  name: string;
  email: string;
  pictureUrl: string | null;
  /** ป้ายประเภทบัญชี (นิสิต / บุคลากร / ...) */
  accountTypeLabel: string;
  className?: string;
};

/**
 * บัตรประจำตัวดิจิทัล — องค์ประกอบเด่นของหน้าที่ login แล้ว (หน้าหลัก, บัญชีของฉัน) ใช้ได้หน้าละ 1 ใบ
 * พื้นสี primary (หมึกน้ำเงิน) + ลายนิรภัยจาง ๆ แบบบัตรจริง — ข้อความใช้ on-primary (contrast 12.8 / 9.8)
 */
export function IdentityCard({ name, email, pictureUrl, accountTypeLabel, className = '' }: IdentityCardProps) {
  return (
    <section
      aria-label="บัตรประจำตัวดิจิทัล"
      className={`@container relative overflow-hidden rounded-xl bg-primary p-5 text-on-primary shadow-card sm:p-6 ${className}`}
    >
      <SecurityPattern className="pointer-events-none absolute -right-24 -bottom-28 size-80 text-on-primary opacity-15" />

      <div className="relative flex items-center gap-3">
        <MsuMark onPrimary className="h-6 w-auto" />
        <p className="leading-tight">
          <span className="block font-display font-semibold tracking-wide">MSU Digital ID</span>
          <span className="block text-xs opacity-80">มหาวิทยาลัยมหาสารคาม</span>
        </p>
      </div>

      <div className="relative mt-8 flex items-center gap-4">
        <Avatar name={name} pictureUrl={pictureUrl} size="lg" />
        <div className="min-w-0">
          <h2 className="font-display text-xl leading-snug font-semibold break-words @md:text-2xl">{name}</h2>
          <p className="text-sm break-all opacity-80">{email}</p>
        </div>
      </div>

      <p className="relative mt-6">
        <span className="rounded-full bg-on-primary px-3 py-1 text-sm font-medium text-primary">{accountTypeLabel}</span>
      </p>
    </section>
  );
}
