import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { lockManagedUser } from '../repositories/admin-user-repository.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import {
  findCertificateForUpdate,
  findCertificateOwnerId,
  findCertificateWithEscrow,
  insertCertificate,
  insertCertificateAuditLog,
  insertKeyEscrow,
  listActiveCertificateExpiries,
  listCertificatesByUser,
  lockUserForCertificate,
  revokeActiveCertificatesByUser,
  revokeCertificate,
  searchCertificates,
  type AdminCertificateRow,
  type CertificateKind,
  type CertificateRow,
  type CertificateStatus,
  type RevocationReason,
} from '../repositories/certificate-repository.js';
import { getCertificatePolicy } from '../repositories/certificate-policy-repository.js';
import { cancelOpenRequestsByUser, insertRequestLog } from '../repositories/supplementary-certificate-request-repository.js';
import {
  cancelOpenPrimaryRequestsByUser,
  insertPrimaryRequestLog,
} from '../repositories/primary-certificate-request-repository.js';
import { canManageUser, hasPermission, type AuthUser } from './authorization-service.js';
import { DAY_MS, primaryExpiryPreview, primaryValidityDays } from './certificate-policy-service.js';
import { issueCrlSafely } from './crl-service.js';
import { PERMISSIONS } from './permissions.js';
import { SignerError, signer, type IssuedCertificate } from './signer-client.js';

// ใบรับรอง S/MIME แบบบริการตนเอง (docs/design/certificates.md)

/** X.509 จำกัด commonName ไม่เกิน 64 ตัวอักษร (ub-common-name) */
export const MAX_COMMON_NAME_LENGTH = 64;
const LIST_LIMIT = 50;

export type Certificate = CertificateRow;

/** ใบรับรองของผู้ใช้ปัจจุบัน (รวมใบที่นำเข้าจากระบบเดิม) */
export async function listMyCertificates(user: AuthUser): Promise<Certificate[]> {
  return listCertificatesByUser(pool, user.id, LIST_LIMIT);
}

/**
 * กฎใบประจำตัว (ตัดสินใจ 2026-10-24): มีใบประจำตัวที่ใช้งานอยู่ได้ 1 ใบ — ขอใบใหม่ได้เมื่อใบประจำตัวทุกใบที่ใช้งานอยู่
 * เหลืออายุไม่เกิน renewalWindowDays (ใบเดิมใช้ต่อจนหมดอายุ) คืนวันที่เริ่มขอได้ หรือ null = ขอได้ทันที
 * ผู้ที่มีใบที่ใช้งานอยู่ 2 ใบจากกฎเดิมยังใช้ต่อได้ — กฎนี้ตรวจเฉพาะตอนขอใบใหม่
 */
function primaryRenewableFrom(activeExpiries: Date[], renewalWindowDays: number, now: Date): Date | null {
  if (activeExpiries.length === 0) return null;
  const latest = Math.max(...activeExpiries.map((d) => d.getTime()));
  const from = latest - renewalWindowDays * DAY_MS;
  return from > now.getTime() ? new Date(from) : null;
}

export type PrimaryRequestStatus = {
  /** วันที่เริ่มขอใบประจำตัวใหม่ได้ (null = ขอได้ตอนนี้) */
  renewableFrom: Date | null;
  /** วันหมดอายุโดยประมาณถ้าขอตอนนี้ (ตามนโยบาย ไม่เกินอายุของ CA) */
  expiresAtIfRequested: Date;
  renewalWindowDays: number;
};

/** สถานะการขอใบประจำตัวของผู้ใช้ — ให้หน้าเว็บแสดงวันหมดอายุล่วงหน้าและวันที่ต่ออายุได้ (API ตรวจซ้ำตอนขอเสมอ) */
export async function getMyPrimaryRequestStatus(user: AuthUser): Promise<PrimaryRequestStatus> {
  const now = new Date();
  const [policy, expiries] = await Promise.all([
    getCertificatePolicy(pool),
    listActiveCertificateExpiries(pool, user.id, 'primary'),
  ]);
  return {
    renewableFrom: primaryRenewableFrom(expiries, policy.renewalWindowDays, now),
    expiresAtIfRequested: primaryExpiryPreview(policy, now),
    renewalWindowDays: policy.renewalWindowDays,
  };
}

export const thaiDate = (date: Date) =>
  date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'long', year: 'numeric' });

export type RequestCertificateInput = {
  p12Password: string;
  legacyP12: boolean;
};

/**
 * ออกใบรับรองประจำตัวให้ผู้ใช้ปัจจุบัน (อายุตามนโยบาย, 1 ใบ + ช่วงต่ออายุ) — subject มาจากฐานข้อมูลเท่านั้น (CN = ชื่อแสดง, อีเมลของบัญชี) ผู้ใช้กำหนดเองไม่ได้
 * คืนไฟล์ .p12 ครั้งเดียว ระบบไม่เก็บไฟล์และรหัสผ่าน (กู้ได้จาก key สำรอง)
 *
 * ทำทั้งหมดใน transaction ที่ล็อกแถวผู้ใช้ไว้ รวมถึงช่วงที่รอ signer (ไม่กี่วินาที):
 * คำขอพร้อมกันของคนเดียวกันต้องรอคิว จึงนับจำนวนใบได้ถูกต้อง และใบที่ CA เซ็นแล้วจะถูกบันทึกเสมอ
 */
/** CN ของใบ = ชื่อแสดงจากฐานข้อมูล (ผู้ใช้กำหนดเองไม่ได้) — ยาวเกินที่ X.509 รองรับ = ปฏิเสธ */
export function certificateCommonName(user: AuthUser): string {
  const commonName = user.name.trim();
  if (commonName.length > MAX_COMMON_NAME_LENGTH) {
    throw new AppError(
      422,
      'CERTIFICATE_NAME_TOO_LONG',
      `ชื่อของคุณยาวเกิน ${MAX_COMMON_NAME_LENGTH} ตัวอักษรซึ่งใบรับรองรองรับ กรุณาติดต่อผู้ดูแลระบบให้กำหนดชื่อแสดงที่สั้นลง`,
    );
  }
  return commonName;
}

export async function requestCertificate(
  user: AuthUser,
  input: RequestCertificateInput,
): Promise<{ certificate: Certificate; p12: Buffer }> {
  const commonName = certificateCommonName(user);

  return withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    return issuePrimaryCertificate(client, { user, commonName, input });
  });
}

/**
 * ขอใบประจำตัวใหม่ได้ตอนนี้หรือไม่ (กฎ 1 ใบ + ช่วงต่ออายุ) — ไม่ได้ = 409 PRIMARY_CERTIFICATE_EXISTS
 * ใช้ทั้งตอนออกใบเอง ตอนส่งคำขอ และตอนรับใบจากคำขอ — ต้องเรียกหลัง lockUserForCertificate ใน transaction เดียวกัน
 */
export async function assertPrimaryRenewable(db: Queryable, userId: string, now: Date): Promise<void> {
  const policy = await getCertificatePolicy(db);
  const renewableFrom = primaryRenewableFrom(
    await listActiveCertificateExpiries(db, userId, 'primary'),
    policy.renewalWindowDays,
    now,
  );
  if (renewableFrom) {
    throw new AppError(
      409,
      'PRIMARY_CERTIFICATE_EXISTS',
      `คุณมีใบรับรองประจำตัวที่ใช้งานอยู่แล้ว ขอใบใหม่เพื่อต่ออายุได้ตั้งแต่วันที่ ${thaiDate(renewableFrom)} หรือเพิกถอนใบเดิมก่อน`,
    );
  }
}

/**
 * ออกใบประจำตัว (อายุตามนโยบาย) แล้วบันทึก — ตรวจกฎ 1 ใบ/ช่วงต่ออายุก่อนเสมอ
 * ผู้เรียกต้องล็อกผู้ใช้ไว้แล้ว (lockUserForCertificate) ตลอดช่วงที่รอ signer
 */
export async function issuePrimaryCertificate(
  db: Queryable,
  input: { user: AuthUser; commonName: string; input: RequestCertificateInput },
): Promise<{ certificate: Certificate; p12: Buffer }> {
  const { user, commonName } = input;
  const now = new Date();
  await assertPrimaryRenewable(db, user.id, now);
  const policy = await getCertificatePolicy(db);

  let issued;
  try {
    issued = await signer.issueCertificate({
      commonName,
      email: user.email,
      p12Password: input.input.p12Password,
      legacyP12: input.input.legacyP12,
      validityDays: primaryValidityDays(policy, now),
    });
  } catch (err) {
    if (!(err instanceof SignerError)) throw err;
    logger.error({ err }, 'ออกใบรับรองไม่สำเร็จ: บริการเซ็นไม่ตอบ');
    throw new AppError(503, 'SIGNER_UNAVAILABLE', 'ระบบออกใบรับรองไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
  }

  const certificate = await recordIssuedCertificate(db, { user, commonName, kind: 'primary', issued });
  return { certificate, p12: issued.p12 };
}

/**
 * บันทึกใบที่ signer ออกแล้ว + key สำรอง + audit log (ใบประจำตัวและใบเสริมใช้ร่วมกัน)
 * ต้องเรียกใน transaction เดียวกับที่ล็อกผู้ใช้ไว้ก่อนเรียก signer
 */
export async function recordIssuedCertificate(
  db: Queryable,
  input: { user: AuthUser; commonName: string; kind: CertificateKind; issued: IssuedCertificate },
): Promise<Certificate> {
  const { user, commonName, kind, issued } = input;
  try {
    const { id } = await insertCertificate(db, {
      userId: user.id,
      serialNumber: issued.serialNumber,
      subjectCn: commonName,
      email: user.email,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
      source: 'issued',
      kind,
      certificatePem: issued.certificatePem,
      fingerprintSha256: issued.fingerprintSha256,
    });
    await insertKeyEscrow(db, { certificateId: id, ...issued.escrow });
    await insertCertificateAuditLog(db, { certificateId: id, actorId: user.id, action: 'issue', reason: null });
    return {
      id,
      serialNumber: issued.serialNumber,
      subjectCn: commonName,
      email: user.email,
      notBefore: issued.notBefore,
      notAfter: issued.notAfter,
      status: 'active',
      revokedAt: null,
      revocationReason: null,
      source: 'issued',
      kind,
      fingerprintSha256: issued.fingerprintSha256,
      hasKeyEscrow: true,
      createdAt: new Date(),
    };
  } catch (err) {
    // CA เซ็นแล้วแต่บันทึกไม่ได้ = มีใบที่ระบบไม่รู้จัก ผู้ดูแลต้องเพิกถอนด้วย serial นี้ (serial ไม่ใช่ข้อมูลส่วนบุคคล)
    logger.error({ err, serialNumber: issued.serialNumber }, 'CA ออกใบรับรองแล้วแต่บันทึกไม่สำเร็จ ต้องเพิกถอน serial นี้');
    throw err;
  }
}

/** ชื่อไฟล์ .p12: อีเมล + serial 8 ตัวแรก ให้แยกไฟล์ของแต่ละใบได้ (ผู้ใช้มีได้หลายใบที่อีเมลเดียวกัน) */
export function p12FileName(email: string, serialNumber: string): string {
  return `${email}-${serialNumber.slice(0, 8)}.p12`;
}

/**
 * permission ที่ต้องมีเพื่อจัดการใบของตัวเอง (เพิกถอน / ดาวน์โหลดใหม่) ตามประเภทใบ
 * ใบประจำตัว = certificate:request หรือ certificate:apply (ได้ใบผ่านคำขอ), ใบเสริม = supplementary_certificate:request
 */
function assertCanManageOwnCertificate(user: AuthUser, kind: CertificateKind): void {
  const allowed =
    kind === 'supplementary'
      ? hasPermission(user, PERMISSIONS.SUPPLEMENTARY_CERTIFICATE_REQUEST)
      : hasPermission(user, PERMISSIONS.CERTIFICATE_REQUEST) || hasPermission(user, PERMISSIONS.CERTIFICATE_APPLY);
  if (!allowed) {
    throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
  }
}

/** เหตุผลที่ผู้ใช้เลือกได้เมื่อเพิกถอนใบของตัวเอง (unspecified/CACompromise สงวนไว้ให้ระบบและผู้ดูแล) */
export const SELF_REVOCATION_REASONS = ['keyCompromise', 'superseded', 'affiliationChanged', 'cessationOfOperation'] as const;
export type SelfRevocationReason = (typeof SELF_REVOCATION_REASONS)[number] & RevocationReason;

/**
 * ผู้ใช้เพิกถอนใบรับรองของตัวเอง — มีผลทันทีในระบบ แล้วออก CRL ใหม่
 * - ใบของคนอื่นตอบ "ไม่พบ" เหมือนใบที่ไม่มีอยู่ (ไม่บอกว่ามีใบนั้นอยู่)
 * - เพิกถอนได้เฉพาะใบที่ยังใช้งานอยู่ (ใบที่หมดอายุแล้วไม่ต้องอยู่ใน CRL)
 * การเพิกถอนกับ audit log อยู่ใน transaction เดียวกัน ส่วน CRL ออกหลัง commit:
 * signer ล่มไม่ทำให้การเพิกถอนล้ม — job ของ CRL เห็นว่าจำนวนใบที่เพิกถอนเพิ่มขึ้นแล้วออกใหม่ให้เอง
 */
export async function revokeMyCertificate(
  user: AuthUser,
  certificateId: string,
  reason: SelfRevocationReason,
): Promise<{ crlUpdated: boolean }> {
  await withTransaction(async (client) => {
    const certificate = await findCertificateForUpdate(client, certificateId);
    if (!certificate || certificate.userId !== user.id) {
      throw new AppError(404, 'CERTIFICATE_NOT_FOUND', 'ไม่พบใบรับรองนี้');
    }
    assertCanManageOwnCertificate(user, certificate.kind);
    if (certificate.revokedAt) {
      throw new AppError(409, 'CERTIFICATE_ALREADY_REVOKED', 'ใบรับรองนี้ถูกเพิกถอนไปแล้ว');
    }
    if (certificate.notAfter <= new Date()) {
      throw new AppError(409, 'CERTIFICATE_EXPIRED', 'ใบรับรองนี้หมดอายุแล้ว ไม่ต้องเพิกถอน');
    }
    await revokeCertificate(client, { id: certificate.id, reason, revokedBy: user.id });
    await insertCertificateAuditLog(client, { certificateId: certificate.id, actorId: user.id, action: 'revoke', reason });
  });

  return { crlUpdated: await issueCrlSafely() };
}

/**
 * ดาวน์โหลด .p12 ใหม่จาก key สำรอง ด้วยรหัสผ่านใหม่ (ลืมรหัสผ่าน / ทำไฟล์หาย / ติดตั้งเครื่องใหม่)
 * ได้ทุกสถานะ รวมใบที่หมดอายุหรือถูกเพิกถอน — key เดิมยังจำเป็นสำหรับเปิดอีเมลเก่าที่เข้ารหัสไว้
 * ยกเว้นใบที่เพิกถอนเพราะ key อาจหลุด (keyCompromise) — ไม่สร้างไฟล์ที่มี key นั้นออกไปอีก
 * ใบของคนอื่นตอบ "ไม่พบ" เหมือนใบที่ไม่มีอยู่ และเขียน audit log ก่อนคืนไฟล์ทุกครั้ง
 */
export async function downloadMyCertificateP12(
  user: AuthUser,
  certificateId: string,
  input: RequestCertificateInput,
): Promise<{ p12: Buffer; fileName: string }> {
  const certificate = await findCertificateWithEscrow(pool, certificateId);
  if (!certificate || certificate.userId !== user.id) {
    throw new AppError(404, 'CERTIFICATE_NOT_FOUND', 'ไม่พบใบรับรองนี้');
  }
  assertCanManageOwnCertificate(user, certificate.kind);
  if (certificate.revocationReason === 'keyCompromise') {
    throw new AppError(
      409,
      'KEY_COMPROMISED',
      'ใบรับรองนี้ถูกเพิกถอนเพราะ key อาจหลุดไปถึงผู้อื่น จึงดาวน์โหลดใหม่ไม่ได้',
    );
  }
  if (!certificate.escrow) {
    throw new AppError(
      409,
      'KEY_NOT_ESCROWED',
      'ใบรับรองนี้ไม่มี key สำรองในระบบ จึงดาวน์โหลดใหม่ไม่ได้ ถ้าไม่มีไฟล์เดิมแล้ว ให้ขอใบรับรองใหม่',
    );
  }

  let p12: Buffer;
  try {
    p12 = await signer.rebuildP12({
      serialNumber: certificate.serialNumber,
      certificatePem: certificate.certificatePem,
      escrow: certificate.escrow,
      p12Password: input.p12Password,
      legacyP12: input.legacyP12,
    });
  } catch (err) {
    if (!(err instanceof SignerError)) throw err;
    logger.error({ err, certificateId }, 'สร้าง .p12 ใหม่จาก key สำรองไม่สำเร็จ');
    throw new AppError(503, 'SIGNER_UNAVAILABLE', 'ระบบออกใบรับรองไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
  }

  await insertCertificateAuditLog(pool, { certificateId: certificate.id, actorId: user.id, action: 'recover', reason: null });
  return { p12, fileName: p12FileName(certificate.email, certificate.serialNumber) };
}

// ---- ผู้ดูแล (certificate:read / certificate:revoke ตรวจที่ route) ----

/**
 * เพิกถอนใบที่ใช้งานอยู่ทั้งหมดของผู้ใช้ เมื่อปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ (ตัดสินใจ 2026-10-08)
 * และยกเลิกคำขอใบเสริมและคำขอใบประจำตัวที่ค้างอยู่ (รออนุมัติ / อนุมัติแล้วยังไม่รับ) — ไม่ให้ออกใบหลังบัญชีถูกปิด
 * ต้องเรียกใน transaction เดียวกับการปิดบัญชี และหลังล็อกแถวผู้ใช้แล้ว — ผู้เรียกออก CRL หลัง commit (issueCrlSafely)
 * actorId = null คือระบบทำเอง (บัญชีหมดอายุ)
 */
export async function revokeCertificatesOfClosedAccount(
  db: Queryable,
  input: { userId: string; actorId: string | null; note: string },
): Promise<number> {
  const ids = await revokeActiveCertificatesByUser(db, {
    userId: input.userId,
    reason: 'cessationOfOperation',
    revokedBy: input.actorId,
  });
  for (const certificateId of ids) {
    await insertCertificateAuditLog(db, { certificateId, actorId: input.actorId, action: 'revoke', reason: input.note });
  }
  for (const requestId of await cancelOpenRequestsByUser(db, input.userId)) {
    await insertRequestLog(db, { requestId, actorId: input.actorId, action: 'cancel' });
  }
  for (const requestId of await cancelOpenPrimaryRequestsByUser(db, input.userId)) {
    await insertPrimaryRequestLog(db, { requestId, actorId: input.actorId, action: 'cancel' });
  }
  return ids.length;
}

const ADMIN_PAGE_SIZE = 20;

/** serial ที่ผู้ดูแลพิมพ์ (อาจมี : หรือช่องว่าง และตัวพิมพ์ใหญ่) → รูปแบบในฐานข้อมูล, ไม่ใช่ serial = null */
function serialFromQuery(q: string): string | null {
  const hex = q.replace(/[\s:]/g, '');
  return /^[0-9a-fA-F]{2,40}$/.test(hex) ? hex.toLowerCase().replace(/^0+(?=.)/, '') : null;
}

export async function searchCertificatesForAdmin(filter: {
  q: string | null;
  status: CertificateStatus | null;
  cursor: string | null;
}): Promise<{ certificates: AdminCertificateRow[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await searchCertificates(pool, {
    q: filter.q,
    serial: filter.q ? serialFromQuery(filter.q) : null,
    status: filter.status,
    afterId: filter.cursor,
    limit: ADMIN_PAGE_SIZE,
  });
  return { certificates: rows, nextCursor };
}

/** ใบรับรองของผู้ใช้คนหนึ่ง (หน้ารายละเอียดผู้ใช้) */
export async function listUserCertificatesForAdmin(userId: string): Promise<Certificate[]> {
  return listCertificatesByUser(pool, userId, LIST_LIMIT);
}

/** เหตุผลที่ผู้ดูแลเลือกได้ (CACompromise สงวนไว้สำหรับเหตุการณ์ระดับ CA ซึ่งต้องจัดการนอกระบบ) */
export const ADMIN_REVOCATION_REASONS = [
  'unspecified',
  'keyCompromise',
  'affiliationChanged',
  'superseded',
  'cessationOfOperation',
] as const;
export type AdminRevocationReason = (typeof ADMIN_REVOCATION_REASONS)[number];

/**
 * ผู้ดูแลเพิกถอนใบรับรองของผู้อื่น (เช่น บุคลากรแจ้งว่า key หลุด) — บันทึกผู้ทำและบันทึกประกอบใน audit log
 * ใช้กฎเดียวกับการจัดการบัญชี (canManageUser): ใบของตัวเองให้เพิกถอนทางหน้าของฉัน, ใบของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin
 * ลำดับล็อก ผู้ใช้ → ใบ (เหมือนการปิดบัญชีที่เพิกถอนใบทั้งหมด) กัน deadlock
 */
export async function adminRevokeCertificate(
  actor: AuthUser,
  certificateId: string,
  reason: AdminRevocationReason,
  note: string,
): Promise<{ crlUpdated: boolean }> {
  await withTransaction(async (client) => {
    const owner = await findCertificateOwnerId(client, certificateId);
    if (!owner) throw new AppError(404, 'CERTIFICATE_NOT_FOUND', 'ไม่พบใบรับรองนี้');
    if (owner.userId) {
      const target = await lockManagedUser(client, owner.userId);
      // เจ้าของถูกลบบัญชีไปแล้ว = ไม่มีกฎของเจ้าของให้ตรวจ
      const denial = target ? canManageUser(actor, target) : null;
      if (denial === 'SELF') {
        throw new AppError(403, 'CANNOT_MANAGE_SELF', 'ใบรับรองของตัวเองให้เพิกถอนที่หน้า "ใบรับรองของฉัน"');
      }
      if (denial === 'PRIVILEGED_TARGET') {
        throw new AppError(403, 'PRIVILEGED_TARGET', 'ใบรับรองของผู้ดูแลระบบจัดการได้เฉพาะผู้ดูแลระบบสูงสุด');
      }
    }

    const certificate = await findCertificateForUpdate(client, certificateId);
    if (!certificate || certificate.userId !== owner.userId) {
      throw new AppError(409, 'CERTIFICATE_CHANGED', 'ใบรับรองถูกเปลี่ยนระหว่างดำเนินการ กรุณาลองใหม่');
    }
    if (certificate.revokedAt) {
      throw new AppError(409, 'CERTIFICATE_ALREADY_REVOKED', 'ใบรับรองนี้ถูกเพิกถอนไปแล้ว');
    }
    if (certificate.notAfter <= new Date()) {
      throw new AppError(409, 'CERTIFICATE_EXPIRED', 'ใบรับรองนี้หมดอายุแล้ว ไม่ต้องเพิกถอน');
    }
    await revokeCertificate(client, { id: certificate.id, reason, revokedBy: actor.id });
    await insertCertificateAuditLog(client, { certificateId: certificate.id, actorId: actor.id, action: 'revoke', reason: note });
  });
  return { crlUpdated: await issueCrlSafely() };
}
