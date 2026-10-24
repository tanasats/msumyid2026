import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/types.js';
import { AppError } from '../errors.js';
import { logger } from '../middlewares/logger.js';
import { lockManagedUser } from '../repositories/admin-user-repository.js';
import { getCertificatePolicy, type CertificatePolicy } from '../repositories/certificate-policy-repository.js';
import { lockUserForCertificate } from '../repositories/certificate-repository.js';
import {
  approveRequest,
  cancelRequest,
  countOpenSupplementary,
  countPendingRequests,
  findRequestById,
  findRequestForUpdate,
  findRequestOwnerId,
  insertRequest,
  insertRequestLog,
  listPendingRequests,
  listRequestsByUser,
  markRequestIssued,
  rejectRequest,
  searchDecidedRequests,
  type AdminSupplementaryRequestRow,
  type RequestStatus,
  type SupplementaryRequestRow,
} from '../repositories/supplementary-certificate-request-repository.js';
import { canManageUser, type AuthUser } from './authorization-service.js';
import { BANGKOK_OFFSET_MS, DAY_MS } from './certificate-policy-service.js';
import {
  certificateCommonName,
  p12FileName,
  recordIssuedCertificate,
  type Certificate,
  type RequestCertificateInput,
} from './certificate-service.js';
import { SignerError, SignerRejectedError, signer } from './signer-client.js';

// ใบรับรองเสริม: ลงนามเอกสารเท่านั้น อายุสั้น ตามช่วงวันที่ที่ได้รับอนุมัติ (docs/design/certificates.md หัวข้อ "ใบรับรองเสริม")
// ผู้ใช้ส่งคำขอ → ผู้มี certificate:approve อนุมัติ (แก้ช่วงได้) → ผู้ใช้กด "รับใบรับรอง" ตั้งรหัส .p12 เอง ระบบจึงออกใบ
// ระบบไม่เก็บรหัส .p12 จึงออกใบตอนผู้ใช้รับ ไม่ใช่ตอนอนุมัติ

const LIST_LIMIT = 50;
const PENDING_LIMIT = 100;
const ADMIN_PAGE_SIZE = 20;

export type SupplementaryRequest = SupplementaryRequestRow;
export type AdminSupplementaryRequest = AdminSupplementaryRequestRow;

// ---- วันที่ตามเวลาประเทศไทย (รูปแบบ YYYY-MM-DD) ----

/** วันนี้ตามเวลาประเทศไทย */
export function bangkokToday(now: Date): string {
  return new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** จำนวนวันของช่วง (นับวันแรกและวันสุดท้าย) */
export function rangeDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/** ใบเริ่ม 00:00:00 ของวันแรก และสิ้นสุด 23:59:59 ของวันสุดท้าย (เวลาประเทศไทย) */
export function rangeToValidity(start: string, end: string): { notBefore: Date; notAfter: Date } {
  return {
    notBefore: new Date(Date.parse(`${start}T00:00:00Z`) - BANGKOK_OFFSET_MS),
    notAfter: new Date(Date.parse(`${end}T23:59:59Z`) - BANGKOK_OFFSET_MS),
  };
}

export type DateRange = { startDate: string; endDate: string };

/**
 * ตรวจช่วงวันที่ตามนโยบาย
 * - submit: วันเริ่มต้องไม่ย้อนหลัง
 * - approve: ยอมให้วันเริ่มผ่านไปแล้ว (คำขอรออนุมัติข้ามวันเริ่ม) แต่ต้องยังไม่สิ้นสุด — ใบจะเริ่มตอนผู้ขอรับใบ
 * ทั้งสองกรณี: วันเริ่มล่วงหน้าไม่เกิน supplementaryMaxLeadDays และยาวไม่เกิน supplementaryMaxDays
 */
function assertValidRange(range: DateRange, policy: CertificatePolicy, today: string, mode: 'submit' | 'approve'): void {
  const fail = (message: string) => {
    throw new AppError(422, 'RANGE_INVALID', message);
  };
  if (range.endDate < range.startDate) fail('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  if (mode === 'submit' && range.startDate < today) fail('วันเริ่มต้องไม่ย้อนหลัง');
  if (mode === 'approve' && range.endDate < today) fail('ช่วงวันที่นี้สิ้นสุดไปแล้ว');
  if (range.startDate > addDays(today, policy.supplementaryMaxLeadDays)) {
    fail(`วันเริ่มล่วงหน้าได้ไม่เกิน ${policy.supplementaryMaxLeadDays} วันนับจากวันนี้`);
  }
  if (rangeDays(range.startDate, range.endDate) > policy.supplementaryMaxDays) {
    fail(`ช่วงวันที่ยาวได้ไม่เกิน ${policy.supplementaryMaxDays} วัน`);
  }
}

/**
 * จำนวนใบเสริม + คำขอที่ค้าง ต้องไม่เกิน supplementaryMaxActive
 * - ส่งคำขอใหม่: ต้องเหลือช่องว่าง (open < max)
 * - อนุมัติ / รับใบ: คำขอนั้นถูกนับอยู่แล้ว (open ≤ max) — ไม่ผ่านเมื่อผู้ดูแลลดเพดานลงภายหลัง
 */
async function assertWithinLimit(
  db: Queryable,
  userId: string,
  policy: CertificatePolicy,
  mode: 'new' | 'existing',
): Promise<void> {
  const open = await countOpenSupplementary(db, userId);
  const max = policy.supplementaryMaxActive;
  if (mode === 'new' ? open < max : open <= max) return;
  throw new AppError(
    409,
    'SUPPLEMENTARY_LIMIT_REACHED',
    max === 0
      ? 'ขณะนี้ยังไม่เปิดให้ขอใบรับรองเสริม'
      : `มีใบรับรองเสริมที่ใช้งานอยู่และคำขอที่ค้างรวมกันได้ไม่เกิน ${max} รายการ`,
  );
}

// ---- ผู้ขอ (ต้อง login เท่านั้น / supplementary_certificate:request — ตรวจที่ route) ----

export type SupplementaryOverview = {
  requests: SupplementaryRequest[];
  limits: { maxDays: number; maxLeadDays: number; maxActive: number; open: number; today: string };
};

/** คำขอของผู้ใช้ + เพดานตามนโยบาย ให้หน้าเว็บตรวจช่วงวันที่ล่วงหน้า (API ตรวจซ้ำตอนส่งเสมอ) */
export async function getMySupplementaryOverview(user: AuthUser): Promise<SupplementaryOverview> {
  const [requests, policy, open] = await Promise.all([
    listRequestsByUser(pool, user.id, LIST_LIMIT),
    getCertificatePolicy(pool),
    countOpenSupplementary(pool, user.id),
  ]);
  return {
    requests,
    limits: {
      maxDays: policy.supplementaryMaxDays,
      maxLeadDays: policy.supplementaryMaxLeadDays,
      maxActive: policy.supplementaryMaxActive,
      open,
      today: bangkokToday(new Date()),
    },
  };
}

/** ส่งคำขอใบเสริม — ล็อกผู้ใช้ก่อนนับ กันส่งหลายคำขอพร้อมกันจนเกินเพดาน */
export async function submitSupplementaryRequest(
  user: AuthUser,
  input: DateRange & { purpose: string },
): Promise<SupplementaryRequest> {
  // ตรวจตั้งแต่ตอนขอ — ชื่อยาวเกินจะออกใบไม่ได้อยู่ดี ไม่ควรให้ผู้อนุมัติเสียเวลา
  certificateCommonName(user);
  const id = await withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    const policy = await getCertificatePolicy(client);
    assertValidRange(input, policy, bangkokToday(new Date()), 'submit');
    await assertWithinLimit(client, user.id, policy, 'new');

    const { id } = await insertRequest(client, { userId: user.id, ...input });
    await insertRequestLog(client, {
      requestId: id,
      actorId: user.id,
      action: 'submit',
      rangeStart: input.startDate,
      rangeEnd: input.endDate,
    });
    return id;
  });
  return findRequest(id);
}

/** ผู้ขอยกเลิกคำขอของตัวเอง (รออนุมัติ หรืออนุมัติแล้วยังไม่รับใบ) — คำขอของคนอื่นตอบ "ไม่พบ" */
export async function cancelMySupplementaryRequest(user: AuthUser, requestId: string): Promise<SupplementaryRequest> {
  await withTransaction(async (client) => {
    const request = await findRequestForUpdate(client, requestId);
    if (!request || request.userId !== user.id) {
      throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
    }
    if (!(await cancelRequest(client, request.id))) {
      throw new AppError(409, 'REQUEST_NOT_CANCELLABLE', 'คำขอนี้ยกเลิกไม่ได้แล้ว');
    }
    await insertRequestLog(client, { requestId: request.id, actorId: user.id, action: 'cancel' });
  });
  return findRequest(requestId);
}

/**
 * รับใบรับรองเสริมจากคำขอที่อนุมัติแล้ว — ผู้ใช้ตั้งรหัส .p12 เอง ระบบออกใบตอนนี้และคืนไฟล์ครั้งเดียว
 * ใบมีผลตั้งแต่วันเริ่มที่อนุมัติ (หรือเวลาที่รับ ถ้าช้ากว่า) ถึงสิ้นวันสุดท้าย — signer ตัดตามเพดานและอายุ CA อีกชั้น
 * ล็อก ผู้ใช้ → คำขอ ตลอดช่วงที่รอ signer เหมือนการขอใบประจำตัว กดซ้ำพร้อมกันจึงได้ใบเดียว
 */
export async function claimSupplementaryCertificate(
  user: AuthUser,
  requestId: string,
  input: RequestCertificateInput,
): Promise<{ certificate: Certificate; p12: Buffer; fileName: string }> {
  const commonName = certificateCommonName(user);
  return withTransaction(async (client) => {
    if (!(await lockUserForCertificate(client, user.id))) {
      throw new AppError(403, 'FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    const request = await findRequestForUpdate(client, requestId);
    if (!request || request.userId !== user.id) {
      throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
    }
    if (request.status === 'issued') {
      throw new AppError(409, 'REQUEST_ALREADY_ISSUED', 'รับใบรับรองของคำขอนี้ไปแล้ว ดาวน์โหลดใหม่ได้ที่รายการใบรับรอง');
    }
    if (request.status !== 'approved' || !request.approvedStart || !request.approvedEnd) {
      throw new AppError(409, 'REQUEST_NOT_APPROVED', 'คำขอนี้ยังไม่ได้รับอนุมัติ');
    }
    if (request.isExpired) {
      throw new AppError(409, 'REQUEST_EXPIRED', 'เลยวันสิ้นสุดของคำขอนี้แล้ว กรุณาส่งคำขอใหม่');
    }
    await assertWithinLimit(client, user.id, await getCertificatePolicy(client), 'existing');

    let issued;
    try {
      issued = await signer.issueCertificate({
        commonName,
        email: user.email,
        p12Password: input.p12Password,
        legacyP12: input.legacyP12,
        profile: 'document_signing',
        ...rangeToValidity(request.approvedStart, request.approvedEnd),
      });
    } catch (err) {
      // สิ้นวันสุดท้ายผ่านไประหว่างกด (เส้นแบ่งเที่ยงคืน) — signer ไม่ออกใบที่หมดอายุแล้ว
      if (err instanceof SignerRejectedError && err.code === 'VALIDITY_INVALID') {
        throw new AppError(409, 'REQUEST_EXPIRED', 'เลยวันสิ้นสุดของคำขอนี้แล้ว กรุณาส่งคำขอใหม่');
      }
      if (!(err instanceof SignerError)) throw err;
      logger.error({ err }, 'ออกใบรับรองเสริมไม่สำเร็จ: บริการเซ็นไม่ตอบ');
      throw new AppError(503, 'SIGNER_UNAVAILABLE', 'ระบบออกใบรับรองไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่ภายหลัง');
    }

    const certificate = await recordIssuedCertificate(client, { user, commonName, kind: 'supplementary', issued });
    await markRequestIssued(client, { id: request.id, certificateId: certificate.id });
    await insertRequestLog(client, { requestId: request.id, actorId: user.id, action: 'issue' });
    return { certificate, p12: issued.p12, fileName: p12FileName(user.email, issued.serialNumber) };
  });
}

// ---- ผู้อนุมัติ (certificate:approve — ตรวจที่ route) ----

/** pending = คิวรออนุมัติ (เก่าก่อน ไม่แบ่งหน้า), all = ประวัติที่ตัดสินแล้วทั้งหมด, อื่น ๆ = ประวัติตามสถานะ */
export type AdminRequestView = 'pending' | 'all' | Exclude<RequestStatus, 'pending'>;

/** เพดานช่วงวันที่ให้หน้าผู้อนุมัติตรวจล่วงหน้า (ผู้อนุมัติอาจไม่มีสิทธิ์ดูนโยบายทั้งชุด) */
export type ApprovalLimits = Pick<SupplementaryOverview['limits'], 'maxDays' | 'maxLeadDays' | 'today'>;

export async function listSupplementaryRequestsForAdmin(filter: {
  view: AdminRequestView;
  cursor: string | null;
}): Promise<{
  requests: AdminSupplementaryRequest[];
  nextCursor: string | null;
  pendingCount: number;
  limits: ApprovalLimits;
}> {
  const [pendingCount, policy] = await Promise.all([countPendingRequests(pool), getCertificatePolicy(pool)]);
  const limits = {
    maxDays: policy.supplementaryMaxDays,
    maxLeadDays: policy.supplementaryMaxLeadDays,
    today: bangkokToday(new Date()),
  };
  if (filter.view === 'pending') {
    return { requests: await listPendingRequests(pool, PENDING_LIMIT), nextCursor: null, pendingCount, limits };
  }
  const { rows, nextCursor } = await searchDecidedRequests(pool, {
    status: filter.view === 'all' ? null : filter.view,
    afterId: filter.cursor,
    limit: ADMIN_PAGE_SIZE,
  });
  return { requests: rows, nextCursor, pendingCount, limits };
}

/**
 * ล็อกผู้ขอแล้วตรวจกฎ canManageUser (เหมือนการเพิกถอนใบของผู้อื่น): คำขอของตัวเองไม่ได้,
 * คำขอของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin — แล้วจึงล็อกคำขอ (ลำดับ ผู้ใช้ → คำขอ เหมือนตอนรับใบ กัน deadlock)
 */
async function lockPendingRequestForDecision(client: Queryable, actor: AuthUser, requestId: string) {
  const ownerId = await findRequestOwnerId(client, requestId);
  if (!ownerId) throw new AppError(404, 'REQUEST_NOT_FOUND', 'ไม่พบคำขอนี้');
  const target = await lockManagedUser(client, ownerId);
  // ผู้ขอถูกลบบัญชี = คำขอถูกยกเลิกไปพร้อมกันแล้ว (ตรวจสถานะด้านล่าง)
  const denial = target ? canManageUser(actor, target) : null;
  if (denial === 'SELF') {
    throw new AppError(403, 'CANNOT_MANAGE_SELF', 'อนุมัติหรือปฏิเสธคำขอของตัวเองไม่ได้');
  }
  if (denial === 'PRIVILEGED_TARGET') {
    throw new AppError(403, 'PRIVILEGED_TARGET', 'คำขอของผู้ดูแลระบบตัดสินได้เฉพาะผู้ดูแลระบบสูงสุด');
  }
  const request = await findRequestForUpdate(client, requestId);
  if (!request || request.userId !== ownerId) {
    throw new AppError(409, 'REQUEST_CHANGED', 'คำขอถูกเปลี่ยนระหว่างดำเนินการ กรุณาลองใหม่');
  }
  if (request.status !== 'pending') {
    throw new AppError(409, 'REQUEST_NOT_PENDING', 'คำขอนี้ถูกตัดสินหรือยกเลิกไปแล้ว');
  }
  return request;
}

/** อนุมัติคำขอ — ผู้อนุมัติกำหนดช่วงวันที่ได้ (ค่าเริ่มต้นที่หน้าเว็บ = ช่วงที่ขอ) ภายในนโยบาย */
export async function approveSupplementaryRequest(
  actor: AuthUser,
  requestId: string,
  input: DateRange & { note: string | null },
): Promise<SupplementaryRequest> {
  await withTransaction(async (client) => {
    const request = await lockPendingRequestForDecision(client, actor, requestId);
    const policy = await getCertificatePolicy(client);
    assertValidRange(input, policy, bangkokToday(new Date()), 'approve');
    await assertWithinLimit(client, request.userId, policy, 'existing');

    await approveRequest(client, { id: request.id, ...input, actorId: actor.id });
    await insertRequestLog(client, {
      requestId: request.id,
      actorId: actor.id,
      action: 'approve',
      rangeStart: input.startDate,
      rangeEnd: input.endDate,
    });
  });
  return findRequest(requestId);
}

/** ปฏิเสธคำขอ (ต้องมีเหตุผล — ผู้ขอเห็น) */
export async function rejectSupplementaryRequest(
  actor: AuthUser,
  requestId: string,
  note: string,
): Promise<SupplementaryRequest> {
  await withTransaction(async (client) => {
    const request = await lockPendingRequestForDecision(client, actor, requestId);
    await rejectRequest(client, { id: request.id, actorId: actor.id, note });
    await insertRequestLog(client, { requestId: request.id, actorId: actor.id, action: 'reject' });
  });
  return findRequest(requestId);
}

/** คำขอหลังเปลี่ยนสถานะ (ไม่รวมข้อมูลผู้ขอ — ผู้ขอเห็นคำขอของตัวเองอยู่แล้ว ผู้อนุมัติเห็นผู้ขอจากรายการ) */
async function findRequest(requestId: string): Promise<SupplementaryRequest> {
  return (await findRequestById(pool, requestId))!;
}
