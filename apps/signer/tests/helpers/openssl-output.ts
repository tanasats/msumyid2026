/**
 * ทำให้ชื่อ (DN) ในข้อความที่ OpenSSL พิมพ์อยู่ในรูปแบบเดียวกันทุกเวอร์ชัน
 * OpenSSL 3.0 (runner ของ GitHub) พิมพ์ "C = TH, O = ..." ส่วน 3.2 ขึ้นไป (dev, image production) พิมพ์ "C=TH, O=..."
 * ใช้เฉพาะใน test — โค้ดของ signer ไม่ได้อ่านข้อความที่ OpenSSL พิมพ์
 */
export function normalizeDn(text: string): string {
  return text.replace(/\b([A-Za-z]+) = /g, '$1=');
}
