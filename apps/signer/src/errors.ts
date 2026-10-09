/**
 * error ที่ตั้งใจส่งให้ผู้เรียก (API) — message ต้องปลอดภัยต่อการแสดง
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
