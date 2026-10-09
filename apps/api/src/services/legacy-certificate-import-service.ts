import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import {
  findCertificatesBySerials,
  insertCertificate,
  insertCertificateAuditLog,
  insertKeyEscrow,
  revokeCertificate,
  type ExistingCertificate,
  type RevocationReason,
} from '../repositories/certificate-repository.js';
import { findUserIdsByEmails } from '../repositories/user-repository.js';
import { issueCrl } from './crl-service.js';
import { SignerError, SignerRejectedError, signer } from './signer-client.js';

// นำเข้าใบรับรองเดิมที่ออกด้วยสคริปต์ OpenSSL (openssl ca) — docs/design/certificates.md หัวข้อ "นำเข้าใบเดิม"
// - index.txt = รายการใบทั้งหมดพร้อมสถานะเพิกถอน, newcerts/ และ certs/ = ไฟล์ใบรับรอง
// - private/<อีเมล>.key.pem + pkcs12-files.csv (อีเมล,ไฟล์ .p12,รหัสผ่าน) = key เดิม → เก็บเป็น key สำรองผ่าน signer
// ต้องนำเข้าใบที่ถูกเพิกถอนครบทุกใบ: CRL ของระบบใหม่แทนฉบับเดิม ถ้าตกหล่น ใบที่เคยเพิกถอนจะกลับมาใช้ได้

const CHUNK_SIZE = 1000;

/** เหตุผลใน index.txt ที่นำเข้าได้ (keyTime/CAkeyTime = เพิกถอนพร้อมวันที่ key หลุด ของ -crl_compromise) */
const INDEX_REASONS: Record<string, RevocationReason> = {
  unspecified: 'unspecified',
  keyCompromise: 'keyCompromise',
  keyTime: 'keyCompromise',
  CACompromise: 'CACompromise',
  CAkeyTime: 'CACompromise',
  affiliationChanged: 'affiliationChanged',
  superseded: 'superseded',
  cessationOfOperation: 'cessationOfOperation',
};

export type IndexEntry = {
  line: number;
  status: 'V' | 'R' | 'E';
  expiresAt: Date;
  revokedAt: Date | null;
  reason: RevocationReason | null;
  serialNumber: string;
};

/** เวลาใน index.txt: UTCTime (YYMMDDHHMMSSZ — ปี 50-99 = 19xx) หรือ GeneralizedTime (YYYYMMDDHHMMSSZ) */
export function parseAsn1Time(value: string): Date {
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new Error(`รูปแบบเวลาไม่ถูกต้อง: ${value}`);
  const [, y, mo, d, h, mi, s] = m;
  const year = y!.length === 4 ? Number(y) : Number(y) < 50 ? 2000 + Number(y) : 1900 + Number(y);
  return new Date(Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/** serial ฐาน 16 ตัวพิมพ์เล็ก ไม่มีเลข 0 นำหน้า (รูปแบบที่เก็บในฐานข้อมูล) */
export function normalizeSerial(hex: string): string {
  return hex.toLowerCase().replace(/^0+(?=.)/, '');
}

/**
 * แยก index.txt ของ openssl ca: สถานะ \t วันหมดอายุ \t วันเพิกถอน[,เหตุผล] \t serial \t ไฟล์ \t subject
 * แถวที่ผิดรูปแบบ/เหตุผลที่รองรับไม่ได้ (เช่น certificateHold) ใส่ใน errors — ผู้เรียกต้องหยุดนำเข้า
 */
export function parseIndex(text: string): { entries: IndexEntry[]; errors: string[] } {
  const entries: IndexEntry[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const fields = raw.split('\t');
    if (fields.length < 4) {
      errors.push(`index.txt บรรทัด ${line}: จำนวนช่องไม่ครบ`);
      return;
    }
    const [status, expiry, revocation, serial] = fields as [string, string, string, string];
    try {
      if (status !== 'V' && status !== 'R' && status !== 'E') throw new Error(`สถานะ "${status}" ไม่รู้จัก`);
      if (!/^[0-9A-Fa-f]+$/.test(serial)) throw new Error(`serial "${serial}" ไม่ถูกต้อง`);
      let revokedAt: Date | null = null;
      let reason: RevocationReason | null = null;
      if (status === 'R') {
        const [date, reasonName] = revocation.split(',');
        if (!date) throw new Error('ใบที่ถูกเพิกถอนไม่มีวันเพิกถอน');
        revokedAt = parseAsn1Time(date);
        reason = reasonName ? (INDEX_REASONS[reasonName] ?? null) : 'unspecified';
        if (!reason) throw new Error(`เหตุผลการเพิกถอน "${reasonName}" ไม่รองรับ`);
      }
      entries.push({ line, status, expiresAt: parseAsn1Time(expiry), revokedAt, reason, serialNumber: normalizeSerial(serial) });
    } catch (err) {
      errors.push(`index.txt บรรทัด ${line}: ${(err as Error).message}`);
    }
  });
  return { entries, errors };
}

/**
 * pkcs12-files.csv ของสคริปต์เดิม: "อีเมล,/pkcs12/อีเมล.p12,รหัสผ่าน" (ต่อท้ายทุกครั้งที่ออกใบ)
 * คืน อีเมลตัวพิมพ์เล็ก → รหัสผ่านทั้งหมด เรียงจากล่าสุดก่อน (key ในไฟล์เป็นของใบล่าสุด)
 */
export function parsePasswordCsv(text: string): Map<string, string[]> {
  const passwords = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const fields = raw.split(',');
    if (fields.length < 3) continue;
    const email = fields[0]!.trim().toLowerCase();
    const password = fields.at(-1)!.trim();
    if (!email || !password) continue;
    passwords.set(email, [password, ...(passwords.get(email) ?? [])]);
  }
  return passwords;
}

type CertificateFile = { pem: string; cert: X509Certificate };

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** อ่านไฟล์ใบรับรองทั้งหมดใน newcerts/ และ certs/ (ข้ามใบของ CA) — serial → ไฟล์ */
async function loadCertificateFiles(dir: string): Promise<Map<string, CertificateFile>> {
  const files = new Map<string, CertificateFile>();
  for (const sub of ['newcerts', 'certs']) {
    const folder = path.join(dir, sub);
    if (!existsSync(folder)) continue;
    for (const name of await readdir(folder)) {
      if (!name.endsWith('.pem')) continue;
      const pem = PEM_BLOCK.exec(await readFile(path.join(folder, name), 'utf8'))?.[0];
      if (!pem) continue;
      const cert = new X509Certificate(pem);
      if (cert.ca) continue;
      const serial = normalizeSerial(cert.serialNumber);
      if (!files.has(serial)) files.set(serial, { pem: `${pem}\n`, cert });
    }
  }
  return files;
}

function subjectField(subject: string, key: string): string | null {
  const line = subject.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

/** อีเมลของใบ: emailAddress ใน subject ก่อน แล้วค่อย subjectAltName (email:copy) */
function certificateEmail(cert: X509Certificate): string | null {
  return (
    subjectField(cert.subject, 'emailAddress') ??
    cert.subjectAltName?.split(', ').find((n) => n.startsWith('email:'))?.slice('email:'.length) ??
    null
  );
}

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) result.push(items.slice(i, i + CHUNK_SIZE));
  return result;
}

type PlannedCertificate = IndexEntry & {
  pem: string;
  subjectCn: string;
  email: string;
  notBefore: Date;
  notAfter: Date;
  fingerprintSha256: string;
};

export type ImportReport = {
  dryRun: boolean;
  indexEntries: number;
  newCertificates: number;
  newRevoked: number;
  alreadyImported: number;
  newlyRevokedExisting: number;
  ownedByExistingUsers: number;
  unowned: number;
  keyFiles: number;
  keysEscrowed: number;
  crlIssued: boolean;
  /** พบแล้วหยุด ไม่มีการเขียนข้อมูล */
  errors: string[];
  /** นำเข้าได้แต่ควรตรวจ (เช่น key ที่ถอดไม่ได้) */
  warnings: string[];
};

/**
 * นำเข้าใบเดิมจากโฟลเดอร์ของ openssl ca — รันซ้ำได้ (ข้ามใบที่มีแล้ว แต่รับการเพิกถอนที่เพิ่มขึ้นในระบบเดิม)
 * ตรวจทั้งหมดก่อน: มี error = ไม่เขียนอะไรเลย, dryRun = ตรวจและลองจับคู่ key โดยไม่เขียน
 * เขียนทั้งหมดใน transaction เดียว แล้วออก CRL ใหม่ (ให้มีใบที่เพิกถอนในระบบเดิมครบ)
 */
export async function importLegacyCertificates(options: {
  dir: string;
  passwordsFile?: string;
  dryRun: boolean;
}): Promise<ImportReport> {
  const report: ImportReport = {
    dryRun: options.dryRun,
    indexEntries: 0,
    newCertificates: 0,
    newRevoked: 0,
    alreadyImported: 0,
    newlyRevokedExisting: 0,
    ownedByExistingUsers: 0,
    unowned: 0,
    keyFiles: 0,
    keysEscrowed: 0,
    crlIssued: false,
    errors: [],
    warnings: [],
  };

  const indexFile = path.join(options.dir, 'index.txt');
  if (!existsSync(indexFile)) {
    report.errors.push(`ไม่พบ ${indexFile}`);
    return report;
  }
  const { entries, errors } = parseIndex(await readFile(indexFile, 'utf8'));
  report.indexEntries = entries.length;
  report.errors.push(...errors);

  // จับคู่แต่ละแถวใน index กับไฟล์ใบรับรอง — ไม่มีไฟล์ = หยุด (ใบที่เพิกถอนต้องอยู่ในระบบให้ครบ)
  const files = await loadCertificateFiles(options.dir);
  const planned: PlannedCertificate[] = [];
  for (const entry of entries) {
    const file = files.get(entry.serialNumber);
    if (!file) {
      report.errors.push(`index.txt บรรทัด ${entry.line}: ไม่พบไฟล์ใบรับรอง serial ${entry.serialNumber} ใน newcerts/ หรือ certs/`);
      continue;
    }
    const email = certificateEmail(file.cert);
    const subjectCn = subjectField(file.cert.subject, 'CN');
    if (!email || !subjectCn) {
      report.errors.push(`serial ${entry.serialNumber}: ใบรับรองไม่มีอีเมลหรือ CN`);
      continue;
    }
    planned.push({
      ...entry,
      pem: file.pem,
      subjectCn,
      email,
      notBefore: new Date(file.cert.validFrom),
      notAfter: new Date(file.cert.validTo),
      fingerprintSha256: file.cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    });
  }
  if (report.errors.length > 0) return report;

  // ใบที่เคยนำเข้าแล้ว (รันซ้ำ)
  const existing = new Map<string, ExistingCertificate>();
  for (const chunk of chunks(planned.map((p) => p.serialNumber))) {
    for (const row of await findCertificatesBySerials(pool, chunk)) existing.set(row.serialNumber, row);
  }
  const fresh = planned.filter((p) => !existing.has(p.serialNumber));
  const newlyRevoked = planned.filter((p) => {
    const row = existing.get(p.serialNumber);
    return row && row.source === 'imported' && p.revokedAt && !row.revokedAt;
  });
  report.newCertificates = fresh.length;
  report.newRevoked = fresh.filter((p) => p.revokedAt).length;
  report.alreadyImported = planned.length - fresh.length;
  report.newlyRevokedExisting = newlyRevoked.length;

  // key เดิม → key สำรอง (ให้ signer ถอดและจับคู่ด้วย public key)
  const escrows = new Map<string, { kekId: string; encryptedKey: Buffer; wrappedDataKey: Buffer }>();
  const privateDir = path.join(options.dir, 'private');
  const passwordsFile = options.passwordsFile ?? path.join(options.dir, 'pkcs12-files.csv');
  if (existsSync(privateDir)) {
    const passwords = existsSync(passwordsFile)
      ? parsePasswordCsv(await readFile(passwordsFile, 'utf8'))
      : new Map<string, string[]>();
    if (!existsSync(passwordsFile)) report.warnings.push(`ไม่พบ ${passwordsFile} — ข้ามการนำเข้า key เดิมทั้งหมด`);

    // key ของผู้ใช้ชื่อ <อีเมล>.key.pem (ไม่ใช่ key ของ CA)
    const keyNames = (await readdir(privateDir)).filter((n) => n.endsWith('.key.pem') && n.includes('@'));
    report.keyFiles = keyNames.length;
    for (const name of keyNames) {
      const email = name.slice(0, -'.key.pem'.length).toLowerCase();
      const passphrases = (passwords.get(email) ?? []).slice(0, 20);
      // ใบทั้งหมดของอีเมลนี้ (ล่าสุดก่อน — key ในไฟล์เป็นของใบล่าสุด) รวมใบที่มี key สำรองแล้ว
      // เพื่อให้รันซ้ำแล้วจับคู่ได้ตามจริง จากนั้นค่อยข้ามถ้าใบที่คู่กันมี key สำรองอยู่แล้ว
      const candidates = planned
        .filter((p) => p.email.toLowerCase() === email)
        .sort((a, b) => b.notBefore.getTime() - a.notBefore.getTime())
        .slice(0, 50);
      if (candidates.length === 0) continue;
      if (passphrases.length === 0) {
        report.warnings.push(`${name}: ไม่พบรหัสผ่านใน pkcs12-files.csv`);
        continue;
      }
      try {
        const result = await signer.escrowLegacyKey({
          privateKeyPem: await readFile(path.join(privateDir, name), 'utf8'),
          passphrases,
          certificates: candidates.map((c) => ({ serialNumber: c.serialNumber, certificatePem: c.pem })),
        });
        if (!existing.get(result.serialNumber)?.hasKeyEscrow) escrows.set(result.serialNumber, result.escrow);
      } catch (err) {
        if (err instanceof SignerRejectedError) {
          report.warnings.push(`${name}: ${err.code === 'KEY_DECRYPT_FAILED' ? 'รหัสผ่านไม่ถูกต้อง' : 'key ไม่คู่กับใบรับรองใด'}`);
          continue;
        }
        if (err instanceof SignerError) {
          report.errors.push(`เรียกบริการเซ็นไม่สำเร็จ: ${err.message}`);
          return report;
        }
        throw err;
      }
    }
  }
  report.keysEscrowed = escrows.size;

  // เจ้าของใบตามอีเมล (ไม่พบ = ผูกเมื่อผู้ใช้ login ครั้งแรก)
  const owners = new Map<string, string>();
  for (const chunk of chunks([...new Set(fresh.map((p) => p.email.toLowerCase()))])) {
    for (const [email, id] of await findUserIdsByEmails(pool, chunk)) owners.set(email, id);
  }
  report.ownedByExistingUsers = fresh.filter((p) => owners.has(p.email.toLowerCase())).length;
  report.unowned = fresh.length - report.ownedByExistingUsers;

  if (options.dryRun) return report;

  await withTransaction(async (client) => {
    const ids = new Map<string, string>();
    for (const p of fresh) {
      const { id } = await insertCertificate(client, {
        userId: owners.get(p.email.toLowerCase()) ?? null,
        serialNumber: p.serialNumber,
        subjectCn: p.subjectCn,
        email: p.email,
        notBefore: p.notBefore,
        notAfter: p.notAfter,
        source: 'imported',
        certificatePem: p.pem,
        fingerprintSha256: p.fingerprintSha256,
        revokedAt: p.revokedAt,
        revocationReason: p.reason,
      });
      ids.set(p.serialNumber, id);
      await insertCertificateAuditLog(client, { certificateId: id, actorId: null, action: 'import', reason: null });
    }
    for (const p of newlyRevoked) {
      const id = existing.get(p.serialNumber)!.id;
      await revokeCertificate(client, { id, reason: p.reason!, revokedBy: null, revokedAt: p.revokedAt! });
      await insertCertificateAuditLog(client, {
        certificateId: id,
        actorId: null,
        action: 'revoke',
        reason: 'เพิกถอนในระบบเดิม (นำเข้า)',
      });
    }
    for (const [serial, escrow] of escrows) {
      const id = ids.get(serial) ?? existing.get(serial)!.id;
      await insertKeyEscrow(client, { certificateId: id, ...escrow });
    }
  });

  try {
    await issueCrl();
    report.crlIssued = true;
  } catch (err) {
    report.warnings.push(`นำเข้าแล้วแต่ออก CRL ไม่สำเร็จ (job จะลองใหม่): ${(err as Error).message}`);
  }
  return report;
}
