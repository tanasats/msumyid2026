import { pool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { insertPrivacyAcknowledgement } from '../repositories/privacy-repository.js';
import type { AuthUser } from './authorization-service.js';

/**
 * เวอร์ชันของประกาศความเป็นส่วนตัว — ต้องตรงกับ PRIVACY_NOTICE_VERSION ใน apps/web/src/components/privacy/PrivacyNotice.tsx
 * เปลี่ยนการเก็บ/เปิดเผยข้อมูลส่วนบุคคล → แก้ข้อความประกาศ + เพิ่มเลขนี้ทั้ง 2 ที่ (ผู้ใช้ทุกคนต้องรับทราบใหม่) และให้ DPO ตรวจก่อน deploy
 * (CLAUDE.md หัวข้อ 18, docs/design/pdpa.md)
 */
export const PRIVACY_NOTICE_VERSION = 1;

/**
 * รับทราบประกาศ — ส่งเวอร์ชันที่ผู้ใช้เห็นมาด้วย ถ้าไม่ใช่เวอร์ชันปัจจุบัน (เปิดหน้าค้างไว้ระหว่างที่ประกาศเปลี่ยน)
 * ปฏิเสธเพื่อให้ผู้ใช้อ่านฉบับใหม่ก่อน
 */
export async function acknowledgePrivacyNotice(user: AuthUser, noticeVersion: number): Promise<void> {
  if (noticeVersion !== PRIVACY_NOTICE_VERSION) {
    throw new AppError(409, 'PRIVACY_NOTICE_OUTDATED', 'ประกาศความเป็นส่วนตัวมีฉบับใหม่ กรุณาอ่านอีกครั้ง');
  }
  await insertPrivacyAcknowledgement(pool, { userId: user.id, noticeVersion });
}
