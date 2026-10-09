import { pool } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createSession } from '../../src/services/session-service.js';

// ตัวช่วยสร้างข้อมูลสำหรับ test (ใช้ SQL ตรงเพื่อเตรียมสถานะ ไม่ผ่าน business logic)

/**
 * ล้างข้อมูลผู้ใช้ทั้งหมดและ role ที่ test สร้าง
 * role_change_logs, user_audit_logs และ certificate_audit_logs กัน TRUNCATE ไว้ จึงปิด trigger ชั่วคราวใน transaction เดียวกัน (ใช้ใน test เท่านั้น)
 */
export async function resetDatabase(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('ALTER TABLE role_change_logs DISABLE TRIGGER trg_role_change_logs_no_truncate');
    await client.query('ALTER TABLE user_audit_logs DISABLE TRIGGER trg_user_audit_logs_no_truncate');
    await client.query('ALTER TABLE certificate_audit_logs DISABLE TRIGGER trg_certificate_audit_logs_no_truncate');
    await client.query(
      `TRUNCATE users, sessions, user_roles, role_change_logs, user_audit_logs, erp_org_units,
                certificates, certificate_key_escrows, certificate_audit_logs, crls CASCADE`,
    );
    await client.query('ALTER TABLE certificate_audit_logs ENABLE TRIGGER trg_certificate_audit_logs_no_truncate');
    await client.query('ALTER TABLE user_audit_logs ENABLE TRIGGER trg_user_audit_logs_no_truncate');
    await client.query('ALTER TABLE role_change_logs ENABLE TRIGGER trg_role_change_logs_no_truncate');
    await client.query(`DELETE FROM role_permissions`);
    await client.query(`DELETE FROM roles WHERE code LIKE 'test\\_%'`);
  });
}

type CreateUserInput = {
  email?: string;
  /** ชื่อ (ใช้ทั้ง name และ display_name) */
  name?: string;
  accountType?: 'student' | 'staff' | 'external' | 'service';
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  isActive?: boolean;
  roles?: string[];
  orgUnitId?: string | null;
  responsibleUserId?: string | null;
  accountExpiresAt?: Date | null;
};

export async function createUser(input: CreateUserInput = {}): Promise<{ id: string }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, display_name, account_type, approval_status, is_active,
                        org_unit_id, responsible_user_id, account_expires_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      `sub-${crypto.randomUUID()}`,
      input.email ?? `user-${crypto.randomUUID().slice(0, 8)}@msu.ac.th`,
      input.name ?? 'ผู้ใช้ทดสอบ',
      input.accountType ?? 'staff',
      input.approvalStatus ?? 'approved',
      input.isActive ?? true,
      input.orgUnitId ?? null,
      input.responsibleUserId ?? null,
      input.accountExpiresAt ?? null,
    ],
  );
  const user = result.rows[0]!;
  for (const role of input.roles ?? ['user']) {
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`,
      [user.id, role],
    );
  }
  return user;
}

/** สร้าง role ชั่วคราวสำหรับ test (ขึ้นต้น test_ เพื่อให้ resetDatabase ลบได้) พร้อมผูก permission */
export async function createTestRole(code: `test_${string}`, permissions: string[]): Promise<void> {
  await pool.query(`INSERT INTO roles (code, name_th) VALUES ($1, $1)`, [code]);
  for (const permission of permissions) {
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = $1 AND p.code = $2`,
      [code, permission],
    );
  }
}

/** สร้าง session แล้วคืนค่า header Cookie ที่ใช้กับ supertest */
export async function loginAs(userId: string): Promise<string> {
  const { token } = await createSession(pool, userId);
  return `${process.env.SESSION_COOKIE_NAME}=${token}`;
}
