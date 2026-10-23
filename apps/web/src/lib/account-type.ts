// ป้ายประเภทบัญชี — แยกจาก auth.ts (ที่ใช้ next/headers) เพื่อให้ Client Component import ได้
// ห้าม import โมดูลฝั่ง server ในไฟล์นี้

/**
 * service = บัญชีหน่วยงาน (ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม ไม่ใช่ของบุคคล)
 * unclassified = รอจำแนกประเภท (บัญชี มมส. ที่ ERP ไม่พบ — ผู้อนุมัติเลือกว่าเป็นบุคลากรภายนอกหรือบัญชีหน่วยงาน)
 */
export type AccountType = 'student' | 'staff' | 'external' | 'service' | 'unclassified';

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  student: 'นิสิต',
  staff: 'บุคลากร',
  external: 'บุคลากรภายนอก',
  service: 'บัญชีหน่วยงาน',
  unclassified: 'รอจำแนกประเภท',
};

/** ประเภทที่ผู้ดูแลเลือกได้ในฟอร์ม — "รอจำแนก" ระบบกำหนดตอน login เท่านั้น */
export const ASSIGNABLE_ACCOUNT_TYPES: Exclude<AccountType, 'unclassified'>[] = ['staff', 'student', 'external', 'service'];

/** ผู้รับผิดชอบบัญชีหน่วยงาน (บุคลากรตัวจริง) */
export type ResponsibleUser = { id: string; displayName: string; email: string };

// วันหมดอายุเลือกเป็น "วัน" (input type="date") — มีผลถึงสิ้นวันนั้นตามเวลาของเครื่องผู้ใช้

/** ค่าจาก input type="date" (YYYY-MM-DD) → ISO 8601 ของเวลา 23:59:59 วันนั้น */
export function expiryDateToIso(date: string): string {
  return new Date(`${date}T23:59:59`).toISOString();
}

/** ISO 8601 → ค่าสำหรับ input type="date" ('' = ไม่หมดอายุ) */
export function isoToExpiryDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** วันนี้ในรูปแบบ YYYY-MM-DD — ใช้เป็นค่าต่ำสุดของช่องวันหมดอายุ */
export function todayDateInput(): string {
  return isoToExpiryDate(new Date().toISOString());
}
