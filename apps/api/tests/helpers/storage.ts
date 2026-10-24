import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { storage } from '../../src/storage/index.js';

// storage จำลองในหน่วยความจำ แทน Garage ใน test ของ API (ฐานข้อมูลยังเป็น app_test จริง)
// presigned URL เป็นข้อความระบุ key — test "อัปโหลด" ด้วย uploadedObject() แทนการ PUT จริง

export type MemoryObject = { body: Buffer; contentType: string };

export function useMemoryStorage() {
  const objects = new Map<string, MemoryObject>();
  vi.spyOn(storage, 'presignUpload').mockImplementation(async (key, { contentType }) => `memory://upload/${key}?type=${contentType}`);
  vi.spyOn(storage, 'presignDownload').mockImplementation(async (key, { fileName }) => `memory://download/${key}?name=${encodeURIComponent(fileName)}`);
  vi.spyOn(storage, 'head').mockImplementation(async (key) => {
    const o = objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  });
  vi.spyOn(storage, 'getBuffer').mockImplementation(async (key) => {
    const o = objects.get(key);
    if (!o) throw new Error(`ไม่มี object ${key}`);
    return o.body;
  });
  vi.spyOn(storage, 'getStream').mockImplementation(async (key) => Readable.from(objects.get(key)?.body ?? Buffer.alloc(0)));
  vi.spyOn(storage, 'put').mockImplementation(async (key, body, contentType) => {
    objects.set(key, { body, contentType });
  });
  vi.spyOn(storage, 'remove').mockImplementation(async (key) => {
    objects.delete(key);
  });
  return {
    objects,
    /** จำลองว่า browser อัปโหลดด้วย presigned URL แล้ว (key อ่านจาก URL ที่ API ออกให้) */
    upload(uploadUrl: string, body: Buffer, contentType: string) {
      const key = decodeURIComponent(new URL(uploadUrl).pathname.replace(/^\//, ''));
      objects.set(key, { body, contentType });
      return key;
    },
  };
}
