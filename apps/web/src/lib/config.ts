// อ่าน config ฝั่ง server ถ้าขาดให้ล้มทันที (ห้ามฮาร์ดโค้ด URL)
// อ่านตอนใช้งาน (getter) ไม่ใช่ตอน import — next build จะได้ไม่ต้องมี env ของ production
// ส่วนการตรวจว่าครบตอนเริ่ม server อยู่ที่ src/instrumentation.ts
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`ต้องกำหนด env ${name} (dev: apps/web/.env.local)`);
  }
  return value;
}

export const serverConfig = {
  get apiUrl(): string {
    return required('API_URL');
  },
  // URL ของ API ที่ browser เข้าถึงได้ (ใช้ทำลิงก์ เช่น ปุ่ม login ด้วย Google)
  // NEXT_PUBLIC_* ถูกฝังตอน build — image ของ production ต้อง build ด้วยค่าจริง
  get publicApiUrl(): string {
    return required('NEXT_PUBLIC_API_URL');
  },
  get sessionCookieName(): string {
    return required('SESSION_COOKIE_NAME');
  },
};

/** ตรวจว่ามี env ครบ — เรียกตอนเริ่ม server (instrumentation.ts) ขาดตัวใดให้ล้มทันที */
export function assertServerConfig(): void {
  void serverConfig.apiUrl;
  void serverConfig.publicApiUrl;
  void serverConfig.sessionCookieName;
}
