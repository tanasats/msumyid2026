import Image from 'next/image';

/*
 * โลโก้มหาวิทยาลัยมหาสารคาม (ไฟล์ต้นฉบับ docs/msu logo/, สร้างไฟล์ใช้งานใน public/brand/)
 * โหมดสว่างใช้แบบสี (เทา-เหลือง) / โหมดมืดใช้แบบขาว — แสดงทั้งสองรูปแล้วซ่อนด้วย variant dark
 * (โหมดบังคับด้วย data-theme ได้ จึงใช้ <picture media> ไม่ได้)
 * ห้ามดัดแปลง สี สัดส่วน หรือใส่เอฟเฟกต์ให้โลโก้ตามแนวทาง CI ของมหาวิทยาลัย
 */

type LogoProps = { className?: string; alt?: string };

/** สัญลักษณ์ (ตัว M) อย่างเดียว — ไอคอนแบรนด์ใน header/sidebar และป้ายเล็ก (สัดส่วน 244:128) */
export function MsuMark({ className = 'h-7 w-auto', alt = '' }: LogoProps) {
  return (
    <>
      <Image src="/brand/msu-mark.png" alt={alt} width={244} height={128} className={`${className} dark:hidden`} />
      <Image src="/brand/msu-mark-white.png" alt={alt} width={244} height={128} className={`${className} hidden dark:block`} />
    </>
  );
}

/** โลโก้เต็ม (สัญลักษณ์ + ชื่อไทย/อังกฤษ) — ใช้ในพื้นที่กว้างพอเท่านั้น (สัดส่วน 1218:128) */
export function MsuLogo({ className = 'h-8 w-auto', alt = 'มหาวิทยาลัยมหาสารคาม' }: LogoProps) {
  return (
    <>
      <Image src="/brand/msu-logo.png" alt={alt} width={1218} height={128} className={`${className} dark:hidden`} />
      <Image src="/brand/msu-logo-white.png" alt={alt} width={1218} height={128} className={`${className} hidden dark:block`} />
    </>
  );
}
