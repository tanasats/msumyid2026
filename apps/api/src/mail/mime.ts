// สร้างอีเมลแบบ MIME (RFC 5322 / 2045 / 2047) สำหรับ Gmail API (users.messages.send รับ raw)
// เนื้อหาเป็นข้อความล้วน UTF-8 — ไม่มี HTML จึงไม่มีช่องให้ข้อความของผู้ใช้กลายเป็น markup/ลิงก์ปลอม

export type MimeMessage = {
  from: { address: string; name: string };
  to: { address: string; name: string | null };
  subject: string;
  text: string;
};

// อีเมลที่ใส่ใน header ได้: ไม่มีช่องว่าง ขึ้นบรรทัดใหม่ หรือ <> (กัน header injection)
const ADDRESS_PATTERN = /^[^\s<>"(),;:\\@]+@[^\s<>"(),;:\\@]+\.[^\s<>"(),;:\\@]+$/;

export function isSendableAddress(address: string): boolean {
  return ADDRESS_PATTERN.test(address);
}

/**
 * header ที่มีอักษรไทย → encoded-word แบบ base64 (RFC 2047)
 * always = เข้ารหัสแม้เป็น ASCII ล้วน (ชื่อผู้รับ — อักขระอย่าง " , < ทำให้ header ผิดรูปได้)
 * แต่ละคำยาวไม่เกิน 75 ตัว จึงตัดเป็นช่วงละไม่เกิน 45 ไบต์ ตรงขอบตัวอักษร (ไม่ตัดกลางอักษร UTF-8) แล้วต่อบรรทัดด้วย CRLF + ช่องว่าง
 */
export function encodeHeaderText(text: string, always = false): string {
  const clean = text.replace(/[\r\n]+/g, ' ');
  if (!always && /^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const char of clean) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function mailbox(address: string, name: string | null): string {
  if (!isSendableAddress(address)) throw new Error('อีเมลไม่อยู่ในรูปแบบที่ส่งได้');
  return name ? `${encodeHeaderText(name, true)} <${address}>` : address;
}

/** base64 ตัดบรรทัดละ 76 ตัวตาม RFC 2045 */
function base64Lines(text: string): string {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

export function buildMime(message: MimeMessage): string {
  const headers = [
    `From: ${mailbox(message.from.address, message.from.name)}`,
    `To: ${mailbox(message.to.address, message.to.name)}`,
    `Subject: ${encodeHeaderText(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    // อีเมลอัตโนมัติ — ระบบตอบกลับอัตโนมัติ (out of office) ไม่ตอบกลับ (RFC 3834)
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${base64Lines(message.text.replace(/\r?\n/g, '\r\n'))}\r\n`;
}
