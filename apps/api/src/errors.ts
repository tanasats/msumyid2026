/**
 * error ที่ตั้งใจส่งให้ client — message ต้องเป็นข้อความที่ปลอดภัยต่อการแสดง (ภาษาไทย)
 * error ชนิดอื่นทั้งหมดจะถูกตอบเป็น 500 แบบไม่เปิดเผยรายละเอียด
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
