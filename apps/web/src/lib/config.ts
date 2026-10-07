// อ่าน config ฝั่ง server ถ้าขาดให้ล้มทันที (ห้ามฮาร์ดโค้ด URL)
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`ต้องกำหนด ${name} ใน apps/web/.env.local`);
  }
  return value;
}

export const serverConfig = {
  apiUrl: required('API_URL'),
  // URL ของ API ที่ browser เข้าถึงได้ (ใช้ทำลิงก์ เช่น ปุ่ม login ด้วย Google)
  publicApiUrl: required('NEXT_PUBLIC_API_URL'),
  sessionCookieName: required('SESSION_COOKIE_NAME'),
};
