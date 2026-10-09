import { pool } from '../db/pool.js';
import { findStaffProfileByUserId, type StaffProfileRow } from '../repositories/staff-profile-repository.js';
import type { AuthUser } from './authorization-service.js';

export type StaffProfile = StaffProfileRow;

/**
 * ข้อมูลบุคลากร (จาก ERP-HR) ของผู้ใช้ปัจจุบัน — ดูได้เฉพาะของตัวเอง
 * null = ไม่ใช่บุคลากร หรือยังไม่เคยดึงข้อมูลจาก ERP สำเร็จ
 */
export async function getMyStaffProfile(user: AuthUser): Promise<StaffProfile | null> {
  return findStaffProfileByUserId(pool, user.id);
}
