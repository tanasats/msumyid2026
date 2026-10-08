// ป้ายประเภทบัญชี — แยกจาก auth.ts (ที่ใช้ next/headers) เพื่อให้ Client Component import ได้
// ห้าม import โมดูลฝั่ง server ในไฟล์นี้

export type AccountType = 'student' | 'staff' | 'external';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  student: 'นิสิต',
  staff: 'บุคลากร',
  external: 'บุคลากรภายนอก',
};
