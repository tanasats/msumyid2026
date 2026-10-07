import { LoaderCircle } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'md' | 'sm';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-hover active:bg-primary-hover',
  secondary: 'border border-line-input bg-surface text-fg hover:bg-slate-100 active:bg-slate-100',
  ghost: 'text-primary hover:bg-primary-soft active:bg-primary-soft',
  danger: 'bg-danger text-white hover:bg-danger-hover active:bg-danger-hover',
};

// md = ปุ่มหลัก/ปุ่มในฟอร์ม (48px), sm = ปุ่มรอง (44px — ขั้นต่ำของพื้นที่แตะ)
const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'h-12 px-5 text-base',
  sm: 'h-11 px-4 text-sm',
};

/**
 * class ของปุ่ม — ใช้กับ <Link> หรือ <a> ที่ต้องหน้าตาเหมือนปุ่มด้วย
 * fullWidth: เต็มความกว้างบนมือถือ แล้วกว้างตามข้อความตั้งแต่ sm ขึ้นไป
 */
export function buttonClasses({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean } = {}) {
  return [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium select-none',
    'transition motion-safe:active:scale-[0.98]',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? 'w-full sm:w-auto' : '',
  ].join(' ');
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** กำลังทำงาน: แสดง spinner และกดซ้ำไม่ได้ */
  loading?: boolean;
};

export function Button({
  variant,
  size,
  fullWidth,
  loading = false,
  disabled,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${buttonClasses({ variant, size, fullWidth })} ${className}`}
      {...rest}
    >
      {loading && <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
