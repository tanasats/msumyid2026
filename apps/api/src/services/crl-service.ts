import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import {
  findLatestCrl,
  getCrlState,
  insertCrl,
  listRevokedCertificates,
  lockCrlIssuance,
  type PublishedCrl,
} from '../repositories/crl-repository.js';
import { signer } from './signer-client.js';

// ออกและเผยแพร่ CRL (docs/design/certificates.md)
// ออกใหม่ทันทีเมื่อมีการเพิกถอน + job ตามรอบ (ออกใหม่เมื่อฉบับล่าสุดเก่าเกิน หรือมีการเพิกถอนที่ยังไม่อยู่ใน CRL)

/** จำนวนใบที่เพิกถอนสูงสุดที่รองรับใน CRL เดียว — เกินแล้วต้องทบทวนการออกแบบ (เช่น ตัดใบที่หมดอายุนานแล้วออก) */
const MAX_REVOKED_IN_CRL = 100_000;

/**
 * เลข CRL ถัดไป: เวลา Unix (วินาที) แต่ต้องมากกว่าฉบับก่อนเสมอ
 * ใช้เวลาเพราะมากกว่าเลขจาก crlnumber ของ openssl ca ระบบเดิมแน่นอน (ระบบเดิมนับทีละ 1 จาก 0x1000)
 * ผู้ตรวจใบรับรองจึงถือว่า CRL ของระบบใหม่ใหม่กว่าฉบับที่เคยเผยแพร่
 */
function nextCrlNumber(previous: bigint | null, now: Date): bigint {
  const fromTime = BigInt(Math.floor(now.getTime() / 1000));
  return previous !== null && previous >= fromTime ? previous + 1n : fromTime;
}

/**
 * ออก CRL ฉบับใหม่จากรายการเพิกถอนทั้งหมด แล้วบันทึกเป็นฉบับล่าสุด
 * ถือ advisory lock ตลอดการออก (รวมช่วงรอ signer) — ฉบับที่ออกพร้อมกันต้องรอคิว เลขจึงเรียงถูกต้องและไม่ชน
 */
export async function issueCrl(): Promise<{ crlNumber: bigint; revokedCount: number }> {
  return withTransaction(async (client) => {
    await lockCrlIssuance(client);
    const { latest } = await getCrlState(client);
    const revoked = await listRevokedCertificates(client, MAX_REVOKED_IN_CRL + 1);
    if (revoked.length > MAX_REVOKED_IN_CRL) {
      throw new Error(`ใบที่เพิกถอนมีมากกว่า ${MAX_REVOKED_IN_CRL} ใบ — ต้องทบทวนการออก CRL`);
    }

    // ตัดเศษมิลลิวินาที: เวลาใน CRL ละเอียดถึงวินาที ให้ค่าในฐานข้อมูลตรงกับในไฟล์
    const thisUpdate = new Date(Math.floor(Date.now() / 1000) * 1000);
    const nextUpdate = new Date(thisUpdate.getTime() + config.crl.validityMs);
    const crlNumber = nextCrlNumber(latest?.crlNumber ?? null, thisUpdate);

    const crlDer = await signer.generateCrl({ crlNumber, thisUpdate, nextUpdate, revoked });
    await insertCrl(client, { crlNumber, thisUpdate, nextUpdate, revokedCount: revoked.length, crlDer });
    return { crlNumber, revokedCount: revoked.length };
  });
}

/**
 * ออก CRL หลังเพิกถอน (หลัง commit) — signer ล่มต้องไม่ทำให้การเพิกถอนล้ม: log ไว้แล้วให้ job ออกให้ภายหลัง
 * (job เห็นว่าจำนวนใบที่เพิกถอนมากกว่าใน CRL ฉบับล่าสุด) คืน true ถ้าออกสำเร็จ
 */
export async function issueCrlSafely(): Promise<boolean> {
  try {
    await issueCrl();
    return true;
  } catch (err) {
    logger.error({ err }, 'เพิกถอนแล้วแต่ออก CRL ไม่สำเร็จ — job จะลองใหม่');
    return false;
  }
}

/** ต้องออก CRL ใหม่หรือไม่: ยังไม่เคยออก / ฉบับล่าสุดเก่าเกินกำหนด / มีการเพิกถอนที่ยังไม่อยู่ใน CRL */
export async function isCrlOutdated(now = new Date()): Promise<boolean> {
  const { latest, revokedNow } = await getCrlState(pool);
  if (!latest) return true;
  if (revokedNow > latest.revokedCount) return true;
  return now.getTime() - latest.thisUpdate.getTime() >= config.crl.reissueHours * 60 * 60 * 1000;
}

/** ออก CRL ใหม่เฉพาะเมื่อจำเป็น — คืน true ถ้าออกใหม่ */
export async function issueCrlIfOutdated(): Promise<boolean> {
  if (!(await isCrlOutdated())) return false;
  await issueCrl();
  return true;
}

/** CRL ฉบับล่าสุดสำหรับเผยแพร่ */
export async function getPublishedCrl(): Promise<PublishedCrl | null> {
  return findLatestCrl(pool);
}

/** แปลง DER เป็น PEM แบบเดียวกับที่ openssl ca -gencrl เขียน (base64 บรรทัดละ 64 ตัว) */
export function crlToPem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN X509 CRL-----\n${lines.join('\n')}\n-----END X509 CRL-----\n`;
}

/**
 * เริ่มตรวจตามรอบ (รอบแรกทันทีตอนเริ่ม API) — คืนฟังก์ชันหยุด สำหรับ graceful shutdown
 * signer ล่มไม่ทำให้ API ล้ม แต่ต้อง log ไว้ (รอบถัดไปจะลองใหม่)
 */
export function startCrlJob(intervalMs: number): () => void {
  let running = false;
  const run = async () => {
    if (running) return; // รอบก่อนยังไม่เสร็จ
    running = true;
    try {
      if (await issueCrlIfOutdated()) logger.info('ออก CRL ฉบับใหม่');
    } catch (err) {
      logger.error({ err }, 'ออก CRL ไม่สำเร็จ จะลองใหม่รอบถัดไป');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
