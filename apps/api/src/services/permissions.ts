// permission ทั้งหมดของระบบ ประกาศที่นี่ที่เดียว (ต้องลงทะเบียนในฐานข้อมูลผ่าน migration ด้วย)
// รูปแบบ resource:action — ห้ามเช็คชื่อ role ตรง ๆ ในโค้ด ให้เช็ค permission แทน
export const PERMISSIONS = {
  /** ให้/ถอน role ที่ไม่ใช่ role สิทธิ์สูงแก่ผู้ใช้อื่น */
  USER_ROLE_ASSIGN: 'user_role:assign',
  /** อนุมัติ/ปฏิเสธบัญชีบุคลากรภายนอกที่รออนุมัติ */
  USER_APPROVE: 'user:approve',
  /** ดูรายชื่อ ค้นหา และดูรายละเอียดผู้ใช้ */
  USER_READ: 'user:read',
  /** ลงทะเบียนผู้ใช้ล่วงหน้าด้วยอีเมล */
  USER_CREATE: 'user:create',
  /** แก้ไขข้อมูลผู้ใช้ */
  USER_UPDATE: 'user:update',
  /** ปิด/เปิดบัญชีผู้ใช้ */
  USER_DEACTIVATE: 'user:deactivate',
  /** ลบบัญชีและข้อมูลส่วนบุคคลของผู้ใช้ */
  USER_DELETE: 'user:delete',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// code ของ role ผู้ดูแลระบบสูงสุด — ใช้ได้เฉพาะใน authorization-service (hasPermission/canGrantRole),
// super-admin-seed-service (ช่องทางเดียวที่สร้าง super_admin คนแรก)
// และ user-admin-service (กฎ "ห้ามปิด/ถอน super_admin คนสุดท้าย")
export const SUPER_ADMIN_ROLE = 'super_admin';
