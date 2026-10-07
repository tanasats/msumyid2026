/** รูปโปรไฟล์จาก Google — ไม่มีรูปให้แสดงอักษรแรกของชื่อแทน */
export function Avatar({ name, pictureUrl, size = 'md' }: { name: string; pictureUrl: string | null; size?: 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'size-16 text-2xl' : 'size-9 text-sm';

  if (pictureUrl) {
    return (
      // ใช้ <img> ตรง ๆ เพราะรูปมาจากโดเมน Google (next/image ต้องตั้ง remotePatterns เพิ่ม)
      // no-referrer: กันรูปของ googleusercontent.com โหลดไม่ขึ้นเมื่อส่ง referrer จาก localhost
      <img
        src={pictureUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={`${sizeClass} shrink-0 rounded-full bg-slate-200 object-cover`}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-semibold text-primary`}
    >
      {name.trim().charAt(0) || '?'}
    </span>
  );
}
