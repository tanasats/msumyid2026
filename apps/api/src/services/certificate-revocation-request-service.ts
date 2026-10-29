import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { AppError } from '../errors.js';
import { lockManagedUser } from '../repositories/admin-user-repository.js';
import {
  findCertificateForUpdate,
  insertCertificateAuditLog,
  lockUserForCertificate,
  revokeCertificate,
} from '../repositories/certificate-repository.js';
import {
  cancelRevocationRequest,
  countPendingRevocationRequests,
  decideRevocationRequest,
  findRevocationRequestById,
  findRevocationRequestForUpdate,
  findRevocationRequestRefs,
  hasPendingRevocationRequest,
  insertRevocationRequest,
  insertRevocationRequestLog,
  listPendingRevocationRequests,
  listRevocationRequestsByUser,
  searchClosedRevocationRequests,
  type AdminRevocationRequestRow,
  type RevocationRequestReason,
  type RevocationRequestRow,
  type RevocationRequestStatus,
} from '../repositories/certificate-revocation-request-repository.js';
import { canManageUser, type AuthUser } from './authorization-service.js';
import { assertCanManageOwnCertificate, canRevokeOwnPrimaryDirectly } from './certificate-service.js';
import { issueCrlSafely } from './crl-service.js';

// คำขอเพิกถอนใบรับรองประจำตัว (ตัดสินใจ 2026-10-29 — docs/design/certificates.md หัวข้อ "การควบคุมการเพิกถอน")
// เหตุผลไม่เร่งด่วน → ผู้ใช้ส่งคำขอ → ผู้มี certificate:revoke อนุมัติ (เพิกถอนทันที + ออก CRL) หรือปฏิเสธ
// ลำดับล็อก ผู้ใช้ → ใบ → คำขอ ทุกเส้นทาง (เหมือนการเพิกถอนทางอื่น) กัน deadlock

/** เหตุผลที่ต้องส่งคำขอ (ตรงกับ CHECK ของตาราง) — keyCompromise เพิกถอนเองที่ /me/certificates/:id/revoke */
export const REVOCATION_REQUEST_REASONS = ['superseded', 'affiliationChanged', 'cessationOfOperation'] as const satisfies readonly RevocationRequestReason[];

const LIST_LIMIT = 50;
const PENDING_LIMIT = 100;
const ADMIN_PAGE_SIZE = 20;

export type RevocationRequest = RevocationRequestRow;
export type AdminRevocationRequest = AdminRevocationRequestRow;

const notFound = () => new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');

// ---- ผู้ขอ ----

/** คำขอของผู้ใช้ปัจจุบัน ล่าสุดก่อน + เพิกถอนใบประจำตัวเองได้ทันทีหรือไม่ (ให้หน้าเว็บเลือกปุ่มที่ถูก) */
export async function listMyRevocationRequests(
  user: AuthUser,
): Promise<{ requests: RevocationRequest[]; canRevokeDirectly: boolean }> {
  return {
    requests: await listRevocationRequestsByUser(pool, { userId: user.id, limit: LIST_LIMIT }),
    canRevokeDirectly: canRevokeOwnPrimaryDirectly(user),
  };
}

/**
 * ส่งคำขอเพิกถอนใบประจำตัวของตัวเอง — ใบต้องยังใช้งานอยู่ และมีคำขอรออนุมัติได้ 1 รายการต่อใบ
 * ใบของคนอื่นตอบ "ไม่พบ" เหมือนใบที่ไม่มีอยู่
 */
export async function submitRevocationRequest(
  user: AuthUser,
  certificateId: string,
  reason: RevocationRequestReason,
): Promise<RevocationRequest> {
  const id = await withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    const certificate = await findCertificateForUpdate(client, certificateId);
    if (!certificate || certificate.userId !== user.id) {
      throw new AppError(404, 'CERTIFICATE_NOT_FOUND', 'ไม่พบใบรับรองนี้');
    }
    assertCanManageOwnCertificate(user, certificate.kind);
    if (certificate.kind !== 'primary') {
      throw new AppError(409, 'REVOCATION_REQUEST_NOT_NEEDED', 'ใบรับรองเสริมเพิกถอนเองได้ทันที ไม่ต้องส่งคำขอ');
    }
    if (certificate.revokedAt) {
      throw new AppError(409, 'CERTIFICATE_ALREADY_REVOKED', 'ใบรับรองนี้ถูกเพิกถอนไปแล้ว');
    }
    if (certificate.notAfter <= new Date()) {
      throw new AppError(409, 'CERTIFICATE_EXPIRED', 'ใบรับรองนี้หมดอายุแล้ว ไม่ต้องเพิกถอน');
    }
    if (await hasPendingRevocationRequest(client, certificate.id)) {
      throw new AppError(409, 'REQUEST_EXISTS', 'ใบรับรองนี้มีคำขอเพิกถอนที่รออนุมัติอยู่แล้ว');
    }
    const { id } = await insertRevocationRequest(client, { certificateId: certificate.id, userId: user.id, reason });
    await insertRevocationRequestLog(client, { requestId: id, actorId: user.id, action: 'submit' });
    return id;
  });
  return (await findRevocationRequestById(pool, id))!;
}

/** ผู้ขอยกเลิกคำขอของตัวเองที่ยังรออนุมัติ — คำขอของคนอื่นตอบ "ไม่พบ" */
export async function cancelMyRevocationRequest(user: AuthUser, requestId: string): Promise<RevocationRequest> {
  await withTransaction(async (client) => {
    const request = await findRevocationRequestForUpdate(client, requestId);
    if (!request || request.userId !== user.id) throw notFound();
    if (!(await cancelRevocationRequest(client, request.id))) {
      throw new AppError(409, 'REQUEST_NOT_CANCELLABLE', 'คำขอนี้ยกเลิกไม่ได้แล้ว');
    }
    await insertRevocationRequestLog(client, { requestId: request.id, actorId: user.id, action: 'cancel' });
  });
  return (await findRevocationRequestById(pool, requestId))!;
}

// ---- ผู้อนุมัติ (certificate:revoke — ตรวจที่ route) ----

export type AdminRevocationRequestView = 'pending' | 'all' | Exclude<RevocationRequestStatus, 'pending'>;

export async function listRevocationRequestsForAdmin(filter: {
  view: AdminRevocationRequestView;
  cursor: string | null;
}): Promise<{ requests: AdminRevocationRequest[]; nextCursor: string | null; pendingCount: number }> {
  const pendingCount = await countPendingRevocationRequests(pool);
  if (filter.view === 'pending') {
    return { requests: await listPendingRevocationRequests(pool, PENDING_LIMIT), nextCursor: null, pendingCount };
  }
  const { rows, nextCursor } = await searchClosedRevocationRequests(pool, {
    status: filter.view === 'all' ? null : filter.view,
    afterId: filter.cursor,
    limit: ADMIN_PAGE_SIZE,
  });
  return { requests: rows, nextCursor, pendingCount };
}

/**
 * อนุมัติ (เพิกถอนใบด้วยเหตุผลที่ผู้ขอเลือก, บันทึกไม่บังคับ) หรือปฏิเสธ (ต้องมีเหตุผล — ผู้ขอเห็น)
 * กฎ canManageUser เหมือนการตัดสินคำขอใบรับรอง: คำขอของตัวเองไม่ได้ (ยกเว้น super_admin), คำขอของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin
 * ใบที่หมดอายุระหว่างรอ อนุมัติไม่ได้ (ไม่ต้องเพิกถอน) ให้ปฏิเสธแทน
 * อนุมัติแล้วออก CRL หลัง commit — signer ล่มไม่ทำให้การอนุมัติล้ม (job ออกให้ภายหลัง)
 */
export async function decideRevocationRequestByAdmin(
  actor: AuthUser,
  requestId: string,
  input: { decision: 'approve' | 'reject'; note: string | null },
): Promise<{ request: RevocationRequest; crlUpdated: boolean | null }> {
  if (input.decision === 'reject' && !input.note) {
    throw new AppError(400, 'VALIDATION_ERROR', 'กรุณาระบุเหตุผล');
  }
  await withTransaction(async (client) => {
    const refs = await findRevocationRequestRefs(client, requestId);
    if (!refs) throw notFound();
    const target = await lockManagedUser(client, refs.userId);
    const denial = target ? canManageUser(actor, target) : null;
    if (denial === 'SELF') throw new AppError(403, 'CANNOT_MANAGE_SELF', 'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้');
    if (denial === 'PRIVILEGED_TARGET') {
      throw new AppError(403, 'PRIVILEGED_TARGET', 'คำขอของผู้ดูแลระบบตัดสินได้เฉพาะผู้ดูแลระบบสูงสุด');
    }
    const certificate = await findCertificateForUpdate(client, refs.certificateId);
    const request = await findRevocationRequestForUpdate(client, requestId);
    if (!certificate || !request) throw notFound();
    if (request.status !== 'pending') {
      throw new AppError(409, 'REQUEST_NOT_PENDING', 'คำขอนี้ถูกตัดสินหรือยกเลิกไปแล้ว');
    }

    if (input.decision === 'approve') {
      // ใบที่ถูกเพิกถอนทางอื่นแล้ว คำขอถูกยกเลิกไปพร้อมกัน (ไม่ถึงตรงนี้) — เหลือกรณีหมดอายุระหว่างรอ
      if (certificate.revokedAt) throw new AppError(409, 'CERTIFICATE_ALREADY_REVOKED', 'ใบรับรองนี้ถูกเพิกถอนไปแล้ว');
      if (certificate.notAfter <= new Date()) {
        throw new AppError(409, 'CERTIFICATE_EXPIRED', 'ใบรับรองนี้หมดอายุแล้ว ไม่ต้องเพิกถอน กรุณาปฏิเสธคำขอนี้แทน');
      }
      await revokeCertificate(client, { id: certificate.id, reason: request.reason, revokedBy: actor.id });
      await insertCertificateAuditLog(client, {
        certificateId: certificate.id,
        actorId: actor.id,
        action: 'revoke',
        reason: input.note ?? 'อนุมัติคำขอเพิกถอน',
      });
    }
    await decideRevocationRequest(client, {
      id: request.id,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      actorId: actor.id,
      note: input.note,
    });
    await insertRevocationRequestLog(client, { requestId: request.id, actorId: actor.id, action: input.decision });
  });

  const crlUpdated = input.decision === 'approve' ? await issueCrlSafely() : null;
  return { request: (await findRevocationRequestById(pool, requestId))!, crlUpdated };
}
