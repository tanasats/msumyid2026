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
};
