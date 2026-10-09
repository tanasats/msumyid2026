import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import {
  countActiveCertificatesByUser,
  findCertificateForUpdate,
  insertCertificate,
  insertCertificateAuditLog,
  insertKeyEscrow,
  listCertificatesByUser,
  lockUserForCertificate,
  revokeCertificate,
  type CertificateRow,
  type RevocationReason,
} from '../repositories/certificate-repository.js';
import type { AuthUser } from './authorization-service.js';
import { issueCrl } from './crl-service.js';
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

  try {
    await issueCrl();
    return { crlUpdated: true };
  } catch (err) {
    logger.error({ err }, 'เพิกถอนแล้วแต่ออก CRL ไม่สำเร็จ — job จะลองใหม่');
    return { crlUpdated: false };
  }
}
