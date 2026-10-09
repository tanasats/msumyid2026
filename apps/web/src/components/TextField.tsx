import { CircleAlert } from 'lucide-react';

type TextFieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  name: string;
  label: string;
  /** ข้อความช่วยเหลือใต้ช่อง เช่น รูปแบบที่ต้องกรอก */
  hint?: string;
  /** ข้อความ error ที่บอกวิธีแก้ — มีค่า = ช่องนี้ผิด */
  error?: string;
  /** ช่องไม่บังคับจะต่อท้ายป้ายด้วย "(ไม่บังคับ)" แทนการติด * ที่ช่องบังคับ */
  optional?: boolean;
};

/**
 * ช่องกรอกข้อความ: ป้ายอยู่เหนือช่องเสมอ, สูง 48px, ตัวอักษร 16px (กัน iOS ซูมอัตโนมัติ)
 * id สร้างจาก name จึงต้องไม่ซ้ำกันในหน้าเดียว
 */
export function TextField({ name, label, hint, error, optional = false, className = '', ...rest }: TextFieldProps) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
        {optional && <span className="font-normal text-muted"> (ไม่บังคับ)</span>}
      </label>
      <input
        id={id}
        name={name}
        required={!optional}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`block h-12 w-full rounded-lg border bg-surface px-3 text-base text-fg placeholder:text-subtle disabled:bg-surface-hover ${
          error ? 'border-danger' : 'border-line-input'
        }`}
        {...rest}
      />
      {hint && (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger-fg">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </div>
  );
}
