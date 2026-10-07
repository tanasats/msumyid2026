import { withTransaction } from '../db/transaction.js';
import { logger } from '../middlewares/logger.js';
import { findRoleHolderIds, grantRoleBySystem } from '../repositories/role-repository.js';
import { findUsersByEmail } from '../repositories/user-repository.js';
import { SUPER_ADMIN_ROLE } from './permissions.js';

export type SeedSuperAdminResult =
  | { ok: true; status: 'granted' | 'already'; userId: string }
  | {
      ok: false;
      reason: 'USER_NOT_FOUND' | 'AMBIGUOUS_EMAIL' | 'NOT_APPROVED' | 'INACTIVE' | 'SUPER_ADMIN_EXISTS';
    };

/**
 * สร้าง super_admin คนแรก — ช่องทางเดียวในระบบ (ไม่มีทาง UI/API) (CLAUDE.md หัวข้อ 9)
 * - ผู้ใช้ต้อง login ด้วย Google มาแล้ว 1 ครั้ง บัญชีต้องได้รับอนุมัติและไม่ถูกระงับ
 * - รันซ้ำได้: ถ้าผู้ใช้คนนี้เป็น super_admin อยู่แล้วจะไม่ทำอะไร
 * - ปฏิเสธถ้ามี super_admin คนอื่นอยู่แล้ว เพื่อไม่ให้การแก้ env กลายเป็นช่องทางเพิ่ม super_admin
 *   (super_admin คนต่อไปต้องให้ผ่านระบบให้/ถอน role ที่มี log ผู้กระทำ)
 */
export async function seedInitialSuperAdmin(email: string): Promise<SeedSuperAdminResult> {
  return withTransaction(async (client) => {
    const users = await findUsersByEmail(client, email);
    if (users.length === 0) return { ok: false, reason: 'USER_NOT_FOUND' };
    if (users.length > 1) return { ok: false, reason: 'AMBIGUOUS_EMAIL' };

    const user = users[0]!;
    if (!user.isActive) return { ok: false, reason: 'INACTIVE' };
    if (user.approvalStatus !== 'approved') return { ok: false, reason: 'NOT_APPROVED' };

    const holders = await findRoleHolderIds(client, SUPER_ADMIN_ROLE, 10);
    if (holders.includes(user.id)) return { ok: true, status: 'already', userId: user.id };
    if (holders.length > 0) return { ok: false, reason: 'SUPER_ADMIN_EXISTS' };

    await grantRoleBySystem(client, {
      userId: user.id,
      roleCode: SUPER_ADMIN_ROLE,
      reason: 'seed ผู้ดูแลระบบสูงสุดคนแรก (INITIAL_SUPER_ADMIN_EMAIL)',
    });
    logger.info({ userId: user.id }, 'ให้ role super_admin คนแรกแล้ว');
    return { ok: true, status: 'granted', userId: user.id };
  });
}
