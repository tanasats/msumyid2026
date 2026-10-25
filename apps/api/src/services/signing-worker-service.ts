import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import { insertCertificateAuditLog } from '../repositories/certificate-repository.js';
import { insertFile } from '../repositories/file-repository.js';
import {
  claimNextSigningJob,
  failPendingJobsOfBatch,
  findSigningJobContext,
  markSigningJobFailed,
  markSigningJobSigned,
  refreshSigningBatchStatus,
  requeueStaleSigningJobs,
  retrySigningJobLater,
  type SigningJobContext,
} from '../repositories/signing-repository.js';
import { storage } from '../storage/index.js';
import { hasPermission, type AuthUser } from './authorization-service.js';
import { PdfSigningError, signPdf, TimestampError } from './pdf-signing/index.js';
import { PERMISSIONS } from './permissions.js';
import { verifyPdfSignatures } from './signature-verification/index.js';
import { SignerError, SignerRejectedError } from './signer-client.js';

// worker ลงนามเอกสาร (process แยกจาก API — src/worker.ts) หยิบงานจาก signing_jobs ทีละงาน:
// ตรวจบัญชี/ใบ/ไฟล์ใหม่จากฐานข้อมูล → อ่านไฟล์จาก storage → signPdf (signer + MSU TSA) → ตรวจซ้ำ
// → เก็บไฟล์ผลลัพธ์ → บันทึกผล + certificate_audit_logs (sign) ใน transaction เดียว
// docs/design/document-signing.md

/** ลองใหม่สูงสุดกี่ครั้ง (นับครั้งแรก) สำหรับความล้มเหลวชั่วคราว: TSA/signer/storage ล่ม */
export const MAX_ATTEMPTS = 3;
/** รอก่อนลองใหม่ตามจำนวนครั้งที่ลองไปแล้ว */
const RETRY_DELAYS_MS = [30_000, 120_000];
/** งานที่ค้างสถานะ signing นานกว่านี้ถือว่า worker ตายกลางทาง (ลงนาม 1 ไฟล์ใช้ไม่กี่วินาที) */
const STALE_AFTER_MS = 10 * 60_000;

/** ใช้แทนเครื่องมือลงนามใน test (TSA จำลอง) — โค้ดจริงเรียกผ่าน object นี้เสมอ */
export const signingEngine = { signPdf };

type Outcome = { kind: 'fail'; code: string; batchWide?: boolean } | { kind: 'retry'; code: string };

class JobOutcome extends Error {
  constructor(public readonly outcome: Outcome) {
    super(outcome.code);
  }
}

const fail = (code: string, batchWide = false) => new JobOutcome({ kind: 'fail', code, batchWide });
const retry = (code: string) => new JobOutcome({ kind: 'retry', code });

/**
 * ตรวจก่อนลงนาม (ค่าล่าสุดจากฐานข้อมูล ไม่ใช่ค่าตอนส่งคำขอ):
 * บัญชียังใช้งานได้และยังมี document:sign, ใบเป็นของผู้ใช้ ยังไม่เพิกถอน อยู่ในช่วงอายุ และมี key สำรอง, ไฟล์ต้นฉบับยังอยู่
 * บัญชี/ใบไม่ผ่าน = ทั้งชุดล้มเหลว (ไฟล์อื่นของชุดก็ลงนามไม่ได้เช่นกัน)
 */
function assertSignable(ctx: SigningJobContext, now: Date): void {
  const user: AuthUser = { ...ctx.user, pictureUrl: null };
  if (!ctx.user.isActive || !hasPermission(user, PERMISSIONS.DOCUMENT_SIGN)) throw fail('ACCOUNT_NOT_ALLOWED', true);
  const c = ctx.certificate;
  if (c.userId !== ctx.user.id || c.revokedAt || c.notAfter <= now || c.notBefore > now || !c.escrow) {
    throw fail('CERTIFICATE_NOT_USABLE', true);
  }
  if (ctx.sourceFile.deleted || ctx.sourceFile.mimeType !== 'application/pdf') throw fail('SOURCE_MISSING');
}

/** ชื่อไฟล์ผลลัพธ์: <ชื่อเดิม>-signed.pdf (ตัดชื่อเดิมให้รวมแล้วไม่เกิน 255 ตัวอักษร) */
export function signedFileName(originalName: string): string {
  const base = originalName.replace(/\.pdf$/i, '').slice(0, 240) || 'document';
  return `${base}-signed.pdf`;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** แปลง error จากการลงนามเป็นผลของงาน — error ที่ไม่รู้จักโยนต่อ (บันทึกเป็น INTERNAL) */
function classifySigningError(err: unknown): JobOutcome {
  if (err instanceof PdfSigningError) return fail(err.code);
  if (err instanceof TimestampError) return retry('TSA_UNAVAILABLE');
  // signer ปฏิเสธ (4xx) เช่น ใบไม่อยู่ในช่วงอายุ / key ไม่คู่กับใบ — ลองใหม่ก็ไม่ผ่าน
  if (err instanceof SignerRejectedError) return fail('CERTIFICATE_NOT_USABLE', true);
  if (err instanceof SignerError) return retry('SIGNER_UNAVAILABLE');
  throw err;
}

/** ลงนาม 1 งานที่หยิบมาแล้ว (status = signing) — ไม่ throw: ทุกผลถูกบันทึกลง signing_jobs */
async function runJob(jobId: string, attempts: number): Promise<void> {
  const log = logger.child({ signingJobId: jobId });
  let ctx: SigningJobContext | null = null;
  let documentSha256: string | null = null;
  let resultKey: string | null = null;
  try {
    ctx = await findSigningJobContext(pool, jobId);
    if (!ctx) throw fail('INTERNAL');
    assertSignable(ctx, new Date());

    let source: Buffer;
    try {
      source = await storage.getBuffer(ctx.sourceFile.objectKey);
    } catch (err) {
      log.warn({ err }, 'อ่านไฟล์ต้นฉบับจาก storage ไม่สำเร็จ');
      throw retry('STORAGE_UNAVAILABLE');
    }
    documentSha256 = sha256(source);

    let signed: Buffer;
    try {
      const result = await signingEngine.signPdf(source, {
        certificate: { serialNumber: ctx.certificate.serialNumber, certificatePem: ctx.certificate.certificatePem, escrow: ctx.certificate.escrow! },
        signerName: ctx.user.name,
        lock: ctx.lockDocument,
      });
      signed = result.pdf;
    } catch (err) {
      const outcome = classifySigningError(err);
      log.warn({ err, code: outcome.outcome.code }, 'ลงนามไม่สำเร็จ');
      throw outcome;
    }

    // ตรวจซ้ำด้วยตัวตรวจเดียวกับหน้า /verify: ต้องมีลายมือชื่อเดียว ครอบคลุมทั้งไฟล์ และตรวจความถูกต้องของข้อมูลผ่าน
    // (ไม่ตรวจความน่าเชื่อถือของสายใบ — ขึ้นกับ trust store ของเครื่องที่รัน)
    const report = await verifyPdfSignatures(signed);
    const [signature, ...others] = report.signatures;
    if (!signature || others.length > 0 || signature.integrity !== 'ok' || !signature.coversWholeDocument) {
      log.error({ signatures: report.signatures.length, integrity: signature?.integrity }, 'ไฟล์ที่ลงนามแล้วตรวจไม่ผ่าน');
      throw fail('VERIFY_FAILED');
    }

    const signedSha256 = sha256(signed);
    resultKey = `signing-result/${crypto.randomUUID()}`;
    try {
      await storage.put(resultKey, signed, 'application/pdf');
    } catch (err) {
      log.warn({ err }, 'เก็บไฟล์ที่ลงนามแล้วไม่สำเร็จ');
      resultKey = null;
      throw retry('STORAGE_UNAVAILABLE');
    }

    const context = ctx;
    const saved = await withTransaction(async (client) => {
      const file = await insertFile(client, {
        bucket: config.s3.bucket,
        objectKey: resultKey!,
        purpose: 'signing_result',
        originalName: signedFileName(context.originalName),
        mimeType: 'application/pdf',
        size: signed.length,
        status: 'uploaded',
        sha256: signedSha256,
        uploadedBy: context.user.id,
        expiresAt: context.batchExpiresAt,
      });
      // งานถูกคืนเข้าคิวระหว่างนี้ (ค้างนานเกิน) = ไม่บันทึกผลซ้อน
      if (!(await markSigningJobSigned(client, { jobId, signedFileId: file.id, documentSha256: documentSha256!, signedSha256 }))) {
        return false;
      }
      // ประวัติถาวร: SHA-256 ก่อน/หลังลงนาม ไม่เก็บชื่อไฟล์ (log ลบไม่ได้ — PDPA)
      await insertCertificateAuditLog(client, {
        certificateId: context.certificate.id,
        actorId: context.user.id,
        action: 'sign',
        reason: `document_sha256=${documentSha256} signed_sha256=${signedSha256}${context.lockDocument ? ' locked' : ''}`,
      });
      await refreshSigningBatchStatus(client, context.batchId);
      return true;
    });
    if (!saved) {
      log.warn('งานถูกคืนเข้าคิวระหว่างลงนาม ทิ้งผลลัพธ์รอบนี้');
      await removeUnusedResult(resultKey);
      return;
    }
    log.info({ attempts }, 'ลงนามเอกสารแล้ว');
  } catch (err) {
    // เก็บไฟล์ผลลัพธ์แล้วแต่บันทึกลงฐานข้อมูลไม่สำเร็จ = ลบ object ทิ้ง (ไม่ให้มี object ที่ไม่มีแถว files อ้างถึง)
    if (resultKey) await removeUnusedResult(resultKey);
    const outcome = err instanceof JobOutcome ? err.outcome : null;
    if (!outcome) log.error({ err }, 'ลงนามเอกสารผิดพลาดโดยไม่คาดคิด');
    await recordFailure(jobId, ctx?.batchId ?? null, outcome ?? { kind: 'fail', code: 'INTERNAL' }, attempts, documentSha256);
  }
}

async function removeUnusedResult(key: string): Promise<void> {
  await storage.remove(key).catch((err: unknown) => logger.error({ err }, 'ลบไฟล์ผลลัพธ์ที่ไม่ใช้ไม่สำเร็จ'));
}

/** บันทึกผลที่ไม่สำเร็จ: ชั่วคราว = คืนเข้าคิว (ถ้ายังลองไม่ครบ), ถาวร = ล้มเหลว แล้วปรับสถานะชุด */
async function recordFailure(
  jobId: string,
  batchId: string | null,
  outcome: Outcome,
  attempts: number,
  documentSha256: string | null,
): Promise<void> {
  try {
    await withTransaction(async (client) => {
      if (outcome.kind === 'retry' && attempts < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
        await retrySigningJobLater(client, { jobId, errorCode: outcome.code, runAfter: new Date(Date.now() + delay) });
        return;
      }
      await markSigningJobFailed(client, { jobId, errorCode: outcome.code, documentSha256 });
      if (!batchId) return;
      if (outcome.kind === 'fail' && outcome.batchWide) await failPendingJobsOfBatch(client, { batchId, errorCode: outcome.code });
      await refreshSigningBatchStatus(client, batchId);
    });
  } catch (err) {
    // ฐานข้อมูลล่ม: งานค้างสถานะ signing แล้วถูกคืนเข้าคิวเมื่อเกินเวลา (requeueStaleJobs)
    logger.error({ err, signingJobId: jobId }, 'บันทึกผลการลงนามไม่สำเร็จ');
  }
}

/** หยิบและทำงานถัดไป 1 งาน — คืน false เมื่อคิวว่าง */
export async function processNextSigningJob(): Promise<boolean> {
  const job = await claimNextSigningJob(pool);
  if (!job) return false;
  await runJob(job.id, job.attempts);
  return true;
}

/** คืนงานที่ค้างสถานะ signing นานเกินเข้าคิว (หรือตั้งล้มเหลวเมื่อลองครบแล้ว) แล้วปรับสถานะชุดที่ได้รับผล */
export async function requeueStaleJobs(now: Date = new Date()): Promise<number> {
  return withTransaction(async (client) => {
    const batchIds = await requeueStaleSigningJobs(client, {
      startedBefore: new Date(now.getTime() - STALE_AFTER_MS),
      maxAttempts: MAX_ATTEMPTS,
      errorCode: 'TIMEOUT',
    });
    for (const batchId of batchIds) await refreshSigningBatchStatus(client, batchId);
    return batchIds.length;
  });
}

/**
 * เริ่ม worker: ทำงานในคิวจนหมด แล้วรอ pollIntervalMs ก่อนดูคิวใหม่ — onTick เรียกหลังทุกรอบที่สำเร็จ (ใช้ทำ heartbeat)
 * stop() รอให้งานที่กำลังทำเสร็จก่อน (graceful shutdown) งานที่ยังไม่หยิบอยู่ในคิวให้ worker ตัวถัดไป
 */
export function startSigningWorker(pollIntervalMs: number, onTick?: () => Promise<void>): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const tick = async () => {
    try {
      const requeued = await requeueStaleJobs();
      if (requeued > 0) logger.warn({ batches: requeued }, 'คืนงานลงนามที่ค้างนานเกินเข้าคิว');
      while (!stopped && (await processNextSigningJob())) {
        // ทำต่อจนคิวว่าง
      }
      await onTick?.();
    } catch (err) {
      // ฐานข้อมูลล่ม = ลองใหม่รอบถัดไป ไม่ทำให้ worker ล้ม
      logger.error({ err }, 'ดึงงานลงนามไม่สำเร็จ จะลองใหม่รอบถัดไป');
    }
    if (!stopped) timer = setTimeout(schedule, pollIntervalMs);
  };
  const schedule = () => {
    current = tick();
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
