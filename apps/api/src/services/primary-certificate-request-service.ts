import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import { lockManagedUser } from '../repositories/admin-user-repository.js';
import { lockUserForCertificate } from '../repositories/certificate-repository.js';
import {
  cancelPrimaryRequest,
  countPendingPrimaryRequests,
  decidePrimaryRequest,
  findPrimaryRequestById,
  findPrimaryRequestForUpdate,
  findPrimaryRequestOwnerId,
  hasOpenPrimaryRequest,
  insertPrimaryRequest,
  insertPrimaryRequestLog,
  listPendingPrimaryRequests,
  listPrimaryRequestsByUser,
  markPrimaryRequestIssued,
  searchDecidedPrimaryRequests,
  type AdminPrimaryRequestRow,
  type PrimaryRequestRow,
  type PrimaryRequestStatus,
} from '../repositories/primary-certificate-request-repository.js';
import { canManageUser, hasPermission, type AuthUser } from './authorization-service.js';
import {
  assertPrimaryRenewable,
  certificateCommonName,
  isPrimaryReissueLimitReached,
  issuePrimaryCertificate,
  p12FileName,
  type Certificate,
  type RequestCertificateInput,
} from './certificate-service.js';
import { PERMISSIONS } from './permissions.js';

// ใบรับรองประจำตัวแบบส่งคำขอ (ผู้มี certificate:apply แต่ไม่มี certificate:request — ตัดสินใจ 2026-10-24)
// ผู้ใช้ส่งคำขอ → ผู้มี certificate:approve อนุมัติ → ผู้ใช้กด "รับใบรับรอง" ตั้งรหัส .p12 เอง ระบบจึงออกใบ (อายุตามนโยบาย)
// กฎใบประจำตัว 1 ใบ + ช่วงต่ออายุ ตรวจทั้งตอนส่งและตอนรับ (assertPrimaryRenewable)
// ผู้มี certificate:request ที่เพิกถอนเกินโควตา (isPrimaryReissueLimitReached) ก็ใช้คำขอนี้แทนการสร้างเอง (ตัดสินใจ 2026-10-29)

/** อนุมัติแล้วต้องรับใบภายในกี่วัน (ตัดสินใจ 2026-10-24) เลยแล้วแสดงเป็น "หมดเวลารับใบ" */
export const PRIMARY_CLAIM_DAYS = 30;
const LIST_LIMIT = 50;
const PENDING_LIMIT = 100;
const ADMIN_PAGE_SIZE = 20;

export type PrimaryRequest = PrimaryRequestRow;
export type AdminPrimaryRequest = AdminPrimaryRequestRow;

// ---- ผู้ขอ ----

/** ใช้คำขอใบประจำตัวได้ = certificate:apply หรือ certificate:request (กรณีเพิกถอนเกินโควตา — ตรวจตอนส่งคำขอ) */
function assertCanUsePrimaryRequests(user: AuthUser): void {
  if (!hasPermission(user, PERMISSIONS.CERTIFICATE_APPLY) && !hasPermission(user, PERMISSIONS.CERTIFICATE_REQUEST)) {
    throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
  }
}

/** คำขอของผู้ใช้ปัจจุบัน ล่าสุดก่อน */
export async function listMyPrimaryRequests(user: AuthUser): Promise<PrimaryRequest[]> {
  return listPrimaryRequestsByUser(pool, { userId: user.id, claimDays: PRIMARY_CLAIM_DAYS, limit: LIST_LIMIT });
}

async function findRequest(id: string): Promise<PrimaryRequest> {
  return (await findPrimaryRequestById(pool, id, PRIMARY_CLAIM_DAYS))!;
}

/** ส่งคำขอ — ล็อกผู้ใช้ก่อนตรวจ กันส่งซ้ำพร้อมกัน; คำขอค้างได้ 1 รายการ และต้องอยู่ในเงื่อนไขที่ขอใบประจำตัวใหม่ได้ */
export async function submitPrimaryRequest(user: AuthUser, input: { purpose: string | null }): Promise<PrimaryRequest> {
  assertCanUsePrimaryRequests(user);
  // ชื่อยาวเกินจะออกใบไม่ได้อยู่ดี — ไม่ควรให้ผู้อนุมัติเสียเวลา
  certificateCommonName(user);
  const id = await withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    if (await hasOpenPrimaryRequest(client, user.id, PRIMARY_CLAIM_DAYS)) {
      throw new AppError(409, 'REQUEST_EXISTS', 'คุณมีคำขอที่รอดำเนินการอยู่แล้ว');
    }
    await assertPrimaryRenewable(client, user.id, new Date());
    // สร้างเองได้ (certificate:request และยังไม่เกินโควตา) = ไม่ต้องรออนุมัติ
    if (
      !hasPermission(user, PERMISSIONS.CERTIFICATE_APPLY) &&
      !(await isPrimaryReissueLimitReached(client, user.id, new Date()))
    ) {
      throw new AppError(409, 'REQUEST_NOT_NEEDED', 'คุณขอใบรับรองประจำตัวได้ทันทีโดยไม่ต้องส่งคำขอ');
    }
    const { id } = await insertPrimaryRequest(client, { userId: user.id, purpose: input.purpose });
    await insertPrimaryRequestLog(client, { requestId: id, actorId: user.id, action: 'submit' });
    return id;
  });
  return findRequest(id);
}

/** ผู้ขอยกเลิกคำขอของตัวเอง (รออนุมัติ หรืออนุมัติแล้วยังไม่รับใบ) — คำขอของคนอื่นตอบ "ไม่พบ" */
export async function cancelMyPrimaryRequest(user: AuthUser, requestId: string): Promise<PrimaryRequest> {
  assertCanUsePrimaryRequests(user);
  await withTransaction(async (client) => {
    const request = await findPrimaryRequestForUpdate(client, requestId, PRIMARY_CLAIM_DAYS);
    if (!request || request.userId !== user.id) throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
    if (!(await cancelPrimaryRequest(client, request.id))) {
      throw new AppError(409, 'REQUEST_NOT_CANCELLABLE', 'คำขอนี้ยกเลิกไม่ได้แล้ว');
    }
    await insertPrimaryRequestLog(client, { requestId: request.id, actorId: user.id, action: 'cancel' });
  });
  return findRequest(requestId);
}

/**
 * รับใบรับรองจากคำขอที่อนุมัติแล้ว — ผู้ใช้ตั้งรหัส .p12 เอง ระบบออกใบตอนนี้และคืนไฟล์ครั้งเดียว
 * ล็อก ผู้ใช้ → คำขอ ตลอดช่วงที่รอ signer กดซ้ำพร้อมกันจึงได้ใบเดียว
 */
export async function claimPrimaryCertificate(
  user: AuthUser,
  requestId: string,
  input: RequestCertificateInput,
): Promise<{ certificate: Certificate; p12: Buffer; fileName: string }> {
  assertCanUsePrimaryRequests(user);
  const commonName = certificateCommonName(user);
  return withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    const request = await findPrimaryRequestForUpdate(client, requestId, PRIMARY_CLAIM_DAYS);
    if (!request || request.userId !== user.id) throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
    if (request.status === 'issued') {
      throw new AppError(409, 'REQUEST_ALREADY_ISSUED', 'รับใบรับรองของคำขอนี้ไปแล้ว ดาวน์โหลดใหม่ได้ที่รายการใบรับรอง');
    }
    if (request.status !== 'approved') throw new AppError(409, 'REQUEST_NOT_APPROVED', 'คำขอนี้ยังไม่ได้รับอนุมัติ');
    if (request.isExpired) {
      throw new AppError(409, 'REQUEST_EXPIRED', `เลยเวลารับใบ (${PRIMARY_CLAIM_DAYS} วันหลังอนุมัติ) แล้ว กรุณาส่งคำขอใหม่`);
    }

    const { certificate, p12 } = await issuePrimaryCertificate(client, { user, commonName, input });
    await markPrimaryRequestIssued(client, { id: request.id, certificateId: certificate.id });
    await insertPrimaryRequestLog(client, { requestId: request.id, actorId: user.id, action: 'issue' });
    return { certificate, p12, fileName: p12FileName(user.email, certificate.serialNumber) };
  });
}

// ---- ผู้อนุมัติ (certificate:approve — ตรวจที่ route) ----

export type AdminPrimaryRequestView = 'pending' | 'all' | Exclude<PrimaryRequestStatus, 'pending'>;

export async function listPrimaryRequestsForAdmin(filter: {
  view: AdminPrimaryRequestView;
  cursor: string | null;
}): Promise<{ requests: AdminPrimaryRequest[]; nextCursor: string | null; pendingCount: number }> {
  const pendingCount = await countPendingPrimaryRequests(pool);
  if (filter.view === 'pending') {
    const requests = await listPendingPrimaryRequests(pool, { claimDays: PRIMARY_CLAIM_DAYS, limit: PENDING_LIMIT });
    return { requests, nextCursor: null, pendingCount };
  }
  const { rows, nextCursor } = await searchDecidedPrimaryRequests(pool, {
    status: filter.view === 'all' ? null : filter.view,
    afterId: filter.cursor,
    limit: ADMIN_PAGE_SIZE,
    claimDays: PRIMARY_CLAIM_DAYS,
  });
  return { requests: rows, nextCursor, pendingCount };
}

/**
 * ล็อกผู้ขอ → ตรวจ canManageUser (คำขอของตัวเองไม่ได้ ยกเว้น super_admin, คำขอของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin)
 * → ล็อกคำขอ (ลำดับ ผู้ใช้ → คำขอ เหมือนตอนรับใบ กัน deadlock)
 */
async function lockPendingRequestForDecision(client: Queryable, actor: AuthUser, requestId: string) {
  const ownerId = await findPrimaryRequestOwnerId(client, requestId);
  if (!ownerId) throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
  const target = await lockManagedUser(client, ownerId);
  const denial = target ? canManageUser(actor, target) : null;
  if (denial === 'SELF') throw new AppError(403, 'CANNOT_MANAGE_SELF', 'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้');
  if (denial === 'PRIVILEGED_TARGET') {
    throw new AppError(403, 'PRIVILEGED_TARGET', 'คำขอของผู้ดูแลระบบตัดสินได้เฉพาะผู้ดูแลระบบสูงสุด');
  }
  const request = await findPrimaryRequestForUpdate(client, requestId, PRIMARY_CLAIM_DAYS);
  if (!request || request.userId !== ownerId) {
    throw new AppError(409, 'REQUEST_CHANGED', 'คำขอถูกเปลี่ยนระหว่างดำเนินการ กรุณาลองใหม่');
  }
  if (request.status !== 'pending') throw new AppError(409, 'REQUEST_NOT_PENDING', 'คำขอนี้ถูกตัดสินหรือยกเลิกไปแล้ว');
  return request;
}

/** อนุมัติ (บันทึกถึงผู้ขอไม่บังคับ) หรือปฏิเสธ (ต้องมีเหตุผล — ผู้ขอเห็น) */
export async function decidePrimaryCertificateRequest(
  actor: AuthUser,
  requestId: string,
  input: { decision: 'approve' | 'reject'; note: string | null },
): Promise<PrimaryRequest> {
  if (input.decision === 'reject' && !input.note) {
    throw new AppError(400, 'VALIDATION_ERROR', 'กรุณาระบุเหตุผล');
  }
  await withTransaction(async (client) => {
    const request = await lockPendingRequestForDecision(client, actor, requestId);
    await decidePrimaryRequest(client, {
      id: request.id,
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      actorId: actor.id,
      note: input.note,
    });
    await insertPrimaryRequestLog(client, { requestId: request.id, actorId: actor.id, action: input.decision });
  });
  return findRequest(requestId);
}
