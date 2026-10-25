import { crc32, deflateRawSync } from 'node:zlib';

// สร้างไฟล์ ZIP ดิบสำหรับ test — ควบคุมชื่อเป็นไบต์ได้เอง (ชื่อ TIS-620 ไม่มี flag UTF-8, path ../) ซึ่งเครื่องมือปกติสร้างไม่ได้

export type RawEntry = {
  /** ชื่อเป็นข้อความ (เข้ารหัส UTF-8 + ตั้ง flag) หรือไบต์ดิบ (ไม่ตั้ง flag) */
  name: string | Buffer;
  data: Buffer;
  /** true = deflate (ค่าเริ่มต้น), false = stored */
  deflate?: boolean;
};

export function buildZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const utf8 = typeof e.name === 'string';
    const name = utf8 ? Buffer.from(e.name as string, 'utf8') : (e.name as Buffer);
    const method = e.deflate === false ? 0 : 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    const flags = utf8 ? 0x800 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}
