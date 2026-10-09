import { readFile } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { config } from '../config/index.js';

export type CaInfo = {
  certPath: string;
  keyPath: string;
  cert: X509Certificate;
  /** ค่าใน subject ของ CA ที่ใบรับรองผู้ใช้ต้องตรงกัน (policy_strict ของระบบเดิม: C และ O ต้อง match) */
  country: string;
  organization: string;
};

let loaded: Promise<CaInfo> | null = null;

/** อ่านค่าหนึ่งช่องจาก subject ของ Node (บรรทัดละ "KEY=value") */
function subjectField(subject: string, key: string): string | null {
  const line = subject.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

async function load(): Promise<CaInfo> {
  const [certPem, keyPem] = await Promise.all([readFile(config.ca.certPath), readFile(config.ca.keyPath)]);
  const cert = new X509Certificate(certPem);
  // ตรวจตั้งแต่เริ่มระบบ: passphrase ถูกต้อง และ key คู่กับใบรับรองของ CA จริง
  const key = createPrivateKey({ key: keyPem, passphrase: config.ca.keyPassphrase });
  if (!cert.checkPrivateKey(key)) {
    throw new Error('CA key ไม่ตรงกับใบรับรองของ CA');
  }
  if (!cert.ca) {
    throw new Error('ใบรับรองที่ CA_CERT_PATH ไม่ใช่ใบรับรองของ CA');
  }
  const country = subjectField(cert.subject, 'C');
  const organization = subjectField(cert.subject, 'O');
  if (!country || !organization) {
    throw new Error('subject ของ CA ต้องมี C และ O');
  }
  return { certPath: config.ca.certPath, keyPath: config.ca.keyPath, cert, country, organization };
}

/** ข้อมูล CA (อ่านครั้งเดียวแล้วจำไว้) — server เรียกตอนเริ่มเพื่อหยุดทันทีถ้าตั้งค่าผิด */
export function loadCa(): Promise<CaInfo> {
  loaded ??= load().catch((err: unknown) => {
    loaded = null; // ให้ลองใหม่ได้ (เช่น แก้ไฟล์แล้ว)
    throw err;
  });
  return loaded;
}
