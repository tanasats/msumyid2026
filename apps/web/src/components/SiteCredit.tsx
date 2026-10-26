import Link from 'next/link';

/**
 * ท้ายหน้า: ลิงก์ประกาศความเป็นส่วนตัว + เครดิตผู้พัฒนาและดูแลระบบ (ยืนยัน 2026-10-26)
 * ใช้ใน PageShell และ footer ของหน้าแลนดิ้ง
 */
export function SiteCredit({ className = '' }: { className?: string }) {
  return (
    <div className={`space-y-1 text-xs leading-relaxed text-muted ${className}`}>
      <p>
        <Link href="/privacy" className="font-medium text-accent underline-offset-4 hover:underline">
          ประกาศความเป็นส่วนตัว
        </Link>
      </p>
      <p>พัฒนาและดูแลระบบโดย ธนศาสตร์ สุดจริง · สำนักคอมพิวเตอร์ มหาวิทยาลัยมหาสารคาม</p>
    </div>
  );
}
