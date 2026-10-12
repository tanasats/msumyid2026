import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { lockManagedUser } from '../repositories/admin-user-repository.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import {
  countActiveCertificatesByUser,
  findCertificateForUpdate,
  findCertificateOwnerId,
  findCertificateWithEscrow,
  insertCertificate,
  insertCertificateAuditLog,
  insertKeyEscrow,
  listCertificatesByUser,
  lockUserForCertificate,
  revokeActiveCertificatesByUser,
  revokeCertificate,
  searchCertificates,
  type AdminCertificateRow,
  type CertificateRow,
  type CertificateStatus,
  type RevocationReason,
} from '../repositories/certificate-repository.js';
import { canManageUser, type AuthUser } from './authorization-service.js';
import { issueCrlSafely } from './crl-service.js';
import { SignerError, signer } from './signer-client.js';

// ใบรับรอง S/MIME แบบบริการตนเอง (docs/design/certificates.md)

/** ใบที่ใช้งานอยู่พร้อมกันได้ต่อคน — ขอใบใหม่ได้ก่อนใบเดิมหมดอายุ (ตัดสินใจ 2026-10-08) */
export const MAX_ACTIVE_CERTIFICATES = 2;
/** X.509 จำกัด commonName ไม่เกิน 64 ตัวอักษร (ub-common-name) */
const MAX_COMMON_NAME_LENGTH = 64;
const LIST_LIMIT = 50;

export type Certificate = CertificateRow;

/** ใบรับรองของผู้ใช้ปัจจุบัน (รวมใบที่นำเข้าจากระบบเดิม) */
export async function listMyCertificates(user: AuthUser): Promise<Certificate[]> {
  return listCertificatesByUser(pool, user.id, LIST_LIMIT);
}

export type RequestCertificateInput = {
  p12Password: string;
  legacyP12: boolean;
};

/**
 * ออกใบรับรองให้ผู้ใช้ปัจจุบัน — subject มาจากฐานข้อมูลเท่านั้น (CN = ชื่อแสดง, อีเมลของบัญชี) ผู้ใช้กำหนดเองไม่ได้
 * คืนไฟล์ .p12 ครั้งเดียว ระบบไม่เก็บไฟล์และรหัสผ่าน (กู้ได้จาก key สำรอง)
 *
 * ทำทั้งหมดใน transaction ที่ล็อกแถวผู้ใช้ไว้ รวมถึงช่วงที่รอ signer (ไม่กี่วินาที):
 * คำขอพร้อมกันของคนเดียวกันต้องรอคิว จึงนับจำนวนใบได้ถูกต้อง และใบที่ CA เซ็นแล้วจะถูกบันทึกเสมอ
 */
export async function requestCertificate(
  user: AuthUser,
  input: RequestCertificateInput,
): Promise<{ certificate: Certificate; p12: Buffer }> {
  const commonName = user.name.trim();
  if (commonName.length > MAX_COMMON_NAME_LENGTH) {
    throw new AppError(
      422,
      'CERTIFICATE_NAME_TOO_LONG',
      `ชื่อของคุณยาวเกิน ${MAX_COMMON_NAME_LENGTH} ตัวอักษรซึ่งใบรับรองรองรับ กรุณาติดต่อผู้ดูแลระบบให้กำหนดชื่อแสดงที่สั้นลง`,
    );
  }

  return withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    const active = await countActiveCertificatesByUser(client, user.id);
    if (active >= MAX_ACTIVE_CERTIFICATES) {
      throw new AppError(
        409,
        'CERTIFICATE_LIMIT_REACHED',
        `คุณมีใบรับรองที่ใช้งานอยู่ครบ ${MAX_ACTIVE_CERTIFICATES} ใบแล้ว ต้องเพิกถอนหรือรอให้ใบเดิมหมดอายุก่อนจึงจะขอใบใหม่ได้`,
      );
    }

    let issued;
    try {
      issued = await signer.issueCertificate({
        commonName,
        email: user.email,
        p12Password: input.p12Password,
        legacyP12: input.legacyP12,
      });
    } catch (err) {
      if (!(err instanceof SignerError)) throw err;
      logger.error({ err }, 'ออกใบรับรองไม่สำเร็จ: บริการเซ็นไม่ตอบ');
      throw new AppError(503, 'SIGNER_UNAVAILABLE', 'ระบบออกใบรับรองไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
    }

    try {
      const { id } = await insertCertificate(client, {
        userId: user.id,
        serialNumber: issued.serialNumber,
        subjectCn: commonName,
        email: user.email,
        notBefore: issued.notBefore,
        notAfter: issued.notAfter,
        source: 'issued',
        certificatePem: issued.certificatePem,
        fingerprintSha256: issued.fingerprintSha256,
      });
      await insertKeyEscrow(client, { certificateId: id, ...issued.escrow });
      await insertCertificateAuditLog(client, { certificateId: id, actorId: user.id, action: 'issue', reason: null });

      return {
        certificate: {
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
          fingerprintSha256: issued.fingerprintSha256,
          hasKeyEscrow: true,
          createdAt: new Date(),
        },
        p12: issued.p12,
      };
    } catch (err) {
      // CA เซ็นแล้วแต่บันทึกไม่ได้ = มีใบที่ระบบไม่รู้จัก ผู้ดูแลต้องเพิกถอนด้วย serial นี้ (serial ไม่ใช่ข้อมูลส่วนบุคคล)
      logger.error({ err, serialNumber: issued.serialNumber }, 'CA ออกใบรับรองแล้วแต่บันทึกไม่สำเร็จ ต้องเพิกถอน serial นี้');
      throw err;
    }
  });
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
  // ต่อท้ายด้วย serial 8 ตัวแรก ให้แยกไฟล์ของแต่ละใบได้ (ผู้ใช้มีได้หลายใบที่อีเมลเดียวกัน)
  return { p12, fileName: `${certificate.email}-${certificate.serialNumber.slice(0, 8)}.p12` };
}

// ---- ผู้ดูแล (certificate:read / certificate:revoke ตรวจที่ route) ----

/**
 * เพิกถอนใบที่ใช้งานอยู่ทั้งหมดของผู้ใช้ เมื่อปิดบัญชี / ลบบัญชี / บัญชีหมดอายุ (ตัดสินใจ 2026-10-08)
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
