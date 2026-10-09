import { readFile } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { config } from '../config/index.js';

export type CaInfo = {
  certPath: string;
  keyPath: string;
  cert: X509Certificate;
  /** ใบรับรอง CA ที่อยู่เหนือ Intermediate (เช่น root ของ Thai University Consortium) เรียงจากใกล้ไปไกล — ว่างได้ */
  chain: X509Certificate[];
  /** PEM ของ Intermediate + chain ต่อกัน ใส่ลงไฟล์ .p12 ให้ผู้ใช้ต่อสายใบรับรองถึง root ได้ */
  bundlePem: string;
  /** วันหมดอายุที่เร็วที่สุดในสาย — ใบของผู้ใช้ต้องไม่หมดอายุช้ากว่านี้ */
  notAfter: Date;
  /** ค่าใน subject ของ CA ที่ใบรับรองผู้ใช้ต้องตรงกัน (policy_strict ของระบบเดิม: C และ O ต้อง match) */
  country: string;
  organization: string;
};

export type CaSource = {
  certPath: string;
  keyPath: string;
  keyPassphrase: string;
  chainPath?: string | undefined;
};

let loaded: Promise<CaInfo> | null = null;

/** อ่านค่าหนึ่งช่องจาก subject ของ Node (บรรทัดละ "KEY=value") */
function subjectField(subject: string, key: string): string | null {
  const line = subject.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

/** แยกใบรับรองทุกใบในไฟล์ PEM (X509Certificate ของ Node อ่านได้ทีละใบ) */
export function parsePemCertificates(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((block) => new X509Certificate(block));
}

/** อ่านและตรวจ CA จากไฟล์ — แยกจาก config เพื่อให้ test ส่ง CA อื่นมาตรวจได้ */
export async function readCa(source: CaSource): Promise<CaInfo> {
  const [certPem, keyPem, chainPem] = await Promise.all([
    readFile(source.certPath),
    readFile(source.keyPath),
    source.chainPath ? readFile(source.chainPath, 'utf8') : Promise.resolve(null),
  ]);
  const cert = new X509Certificate(certPem);
  // ตรวจตั้งแต่เริ่มระบบ: passphrase ถูกต้อง และ key คู่กับใบรับรองของ CA จริง
  const key = createPrivateKey({ key: keyPem, passphrase: source.keyPassphrase });
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

  // สายใบรับรอง: ทุกใบต้องเป็น CA และเซ็นใบที่อยู่ถัดลงมาจริง (ไม่ใช่แค่ชื่อตรงกัน)
  const chain = chainPem === null ? [] : parsePemCertificates(chainPem);
  if (chainPem !== null && chain.length === 0) {
    throw new Error('ไม่พบใบรับรองในไฟล์ CA_CHAIN_PATH');
  }
  let child = cert;
  for (const parent of chain) {
    if (!parent.ca) {
      throw new Error(`ใบรับรอง "${parent.subject.replaceAll('\n', ', ')}" ใน CA_CHAIN_PATH ไม่ใช่ใบของ CA`);
    }
    if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
      throw new Error(`ใบรับรองใน CA_CHAIN_PATH ไม่ได้ออก "${child.subject.replaceAll('\n', ', ')}" (เรียงจาก Intermediate ขึ้นไปหา root)`);
    }
    child = parent;
  }

  const all = [cert, ...chain];
  const notAfter = new Date(Math.min(...all.map((c) => new Date(c.validTo).getTime())));
  const bundlePem = all.map((c) => c.toString().trim()).join('\n') + '\n';
  return { certPath: source.certPath, keyPath: source.keyPath, cert, chain, bundlePem, notAfter, country, organization };
}

/** ข้อมูล CA (อ่านครั้งเดียวแล้วจำไว้) — server เรียกตอนเริ่มเพื่อหยุดทันทีถ้าตั้งค่าผิด */
export function loadCa(): Promise<CaInfo> {
  loaded ??= readCa(config.ca).catch((err: unknown) => {
    loaded = null; // ให้ลองใหม่ได้ (เช่น แก้ไฟล์แล้ว)
    throw err;
  });
  return loaded;
}
