// permission ทั้งหมดของระบบ ประกาศที่นี่ที่เดียว (ต้องลงทะเบียนในฐานข้อมูลผ่าน migration ด้วย)
// รูปแบบ resource:action — ห้ามเช็คชื่อ role ตรง ๆ ในโค้ด ให้เช็ค permission แทน
export const PERMISSIONS = {
  /** ให้/ถอน role ที่ไม่ใช่ role สิทธิ์สูงแก่ผู้ใช้อื่น */
  USER_ROLE_ASSIGN: 'user_role:assign',
  /** อนุมัติ/ปฏิเสธบัญชีบุคลากรภายนอกที่รออนุมัติ */
  USER_APPROVE: 'user:approve',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// code ของ role ผู้ดูแลระบบสูงสุด — ใช้ได้เฉพาะใน authorization-service (hasPermission/canGrantRole)
// และ super-admin-seed-service (ช่องทางเดียวที่สร้าง super_admin คนแรก)
export const SUPER_ADMIN_ROLE = 'super_admin';
