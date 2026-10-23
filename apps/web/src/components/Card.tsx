/**
 * กล่องเนื้อหามาตรฐานของระบบ (พื้น surface + เส้นขอบ + เงาบาง) และกริดแบบ bento
 * แนวทาง: docs/design/ui-guidelines.md หัวข้อ 6.4
 */

/** class ของกล่อง — ใช้กับ element อื่นที่ต้องหน้าตาเหมือน Card (เช่น <Link>) */
export const cardClasses = 'rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6';

type CardProps = {
  children: React.ReactNode;
  /** หัวข้อของกล่อง (h2) — ไม่ระบุ = กล่องจัดหัวข้อเอง */
  title?: string;
  description?: React.ReactNode;
  /** class เพิ่ม เช่น ช่องในกริด lg:col-span-2 */
  className?: string;
};

export function Card({ children, title, description, className = '' }: CardProps) {
  return (
    <section className={`${cardClasses} ${className}`}>
      {title && <h2 className="font-display text-lg font-semibold">{title}</h2>}
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      {children}
    </section>
  );
}

/**
 * กริด bento: มือถือเรียงแถวเดียว → tablet 2 คอลัมน์ → desktop 3 คอลัมน์
 * ช่องกำหนดขนาดเองด้วย md:col-span-2 / lg:col-span-2 / lg:row-span-2
 * grid-flow-dense: ช่องเล็กเติมช่องว่างที่ช่องใหญ่เหลือไว้ (ลำดับบนมือถือยังตาม DOM)
 */
export function BentoGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid grid-flow-dense gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-6 ${className}`}>{children}</div>
  );
}
