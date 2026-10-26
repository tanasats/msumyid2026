import Link from 'next/link';

/**
 * ท้ายหน้า: เครดิตผู้พัฒนาและดูแลระบบ (ยืนยัน 2026-10-26) + ลิงก์ประกาศความเป็นส่วนตัว
 * ลิงก์แสดงเฉพาะหน้าที่เห็นก่อน login (แลนดิ้ง, login, /verify) ให้อ่านประกาศได้ก่อนระบบเก็บข้อมูล
 * — ผู้ใช้ที่ login แล้วรับทราบไปแล้ว ดูซ้ำได้ที่หน้าบัญชีของฉัน (ยืนยัน 2026-10-26)
 */
export function SiteCredit({ showPrivacyLink = true, className = '' }: { showPrivacyLink?: boolean; className?: string }) {
  return (
    <div className={`space-y-1 text-xs leading-relaxed text-muted ${className}`}>
      {showPrivacyLink && (
        <p>
          <Link href="/privacy" className="font-medium text-accent underline-offset-4 hover:underline">
            ประกาศความเป็นส่วนตัว
          </Link>
        </p>
      )}
      <p>พัฒนาและดูแลระบบโดย ธนศาสตร์ สุดจริง · สำนักคอมพิวเตอร์ มหาวิทยาลัยมหาสารคาม</p>
    </div>
  );
}
