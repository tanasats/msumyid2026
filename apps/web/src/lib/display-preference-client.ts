// เขียน cookie ของการตั้งค่าการแสดงผล (โหมดสี / ขนาดตัวอักษร) จาก browser — ใช้ใน Client Component เท่านั้น
// อายุ 1 ปี, ทั้งเว็บ (path=/), SameSite=Lax — ไม่ใช่ข้อมูลส่วนบุคคลและไม่ส่งไป API

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function setPreferenceCookie(name: string, value: string): void {
  document.cookie = `${name}=${value}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}
