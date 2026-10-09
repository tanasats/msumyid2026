import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../src/db/pool.js';

// test กฎที่บังคับในฐานข้อมูล (trigger / constraint) กับ app_test จริง
// ทุก test รันใน transaction แล้ว ROLLBACK เพื่อไม่ทิ้งข้อมูลไว้

afterAll(async () => {
  await pool.end();
});

async function inRollback(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function createUser(client: PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO users (google_sub, email, name, display_name, account_type)
     VALUES ($1, $2, $3, $3, 'staff') RETURNING id`,
    [`sub-${crypto.randomUUID()}`, 'test@msu.ac.th', 'ทดสอบ'],
  );
  return result.rows[0]!.id;
}

describe('ข้อมูลตั้งต้น', () => {
  it('มี role ตั้งต้นครบ 7 ตัว พร้อม is_system / is_privileged ถูกต้อง', async () => {
    const { rows } = await pool.query<{ code: string; is_system: boolean; is_privileged: boolean }>(
      'SELECT code, is_system, is_privileged FROM roles ORDER BY code',
    );
    expect(rows).toEqual([
      { code: 'admin', is_system: false, is_privileged: true },
      { code: 'external', is_system: true, is_privileged: false },
      { code: 'service', is_system: true, is_privileged: false },
      { code: 'staff', is_system: true, is_privileged: false },
      { code: 'student', is_system: true, is_privileged: false },
      { code: 'super_admin', is_system: true, is_privileged: true },
      { code: 'user', is_system: true, is_privileged: false },
    ]);
  });

  it('permission ยังไม่ถูกผูกกับ role ใด', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM role_permissions');
    expect(rows[0]!.n).toBe(0);
  });

  it('มีหน่วยงานจาก faculties.csv ครบ 42 แห่ง', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM org_units');
    expect(rows[0]!.n).toBe(42);
  });
});

describe('กฎในฐานข้อมูล', () => {
  it('ห้ามลบ role ระบบ', async () => {
    await inRollback(async (client) => {
      await expect(client.query(`DELETE FROM roles WHERE code = 'user'`)).rejects.toThrow(/ห้ามลบ role ระบบ/);
    });
  });

  it('ห้ามเปลี่ยน code ของ role ระบบ', async () => {
    await inRollback(async (client) => {
      await expect(client.query(`UPDATE roles SET code = 'member' WHERE code = 'user'`)).rejects.toThrow(
        /ห้ามเปลี่ยน code/,
      );
    });
  });

  it('role ที่ไม่ใช่ระบบลบได้', async () => {
    await inRollback(async (client) => {
      const result = await client.query(`DELETE FROM roles WHERE code = 'admin'`);
      expect(result.rowCount).toBe(1);
    });
  });

  it('role_change_logs แก้ไขหรือลบไม่ได้', async () => {
    await inRollback(async (client) => {
      const userId = await createUser(client);
      await client.query(
        `INSERT INTO role_change_logs (target_user_id, role_id, action, reason)
         SELECT $1, id, 'grant', 'ทดสอบ' FROM roles WHERE code = 'user'`,
        [userId],
      );
      await client.query('SAVEPOINT s1');
      await expect(client.query(`UPDATE role_change_logs SET reason = 'แก้'`)).rejects.toThrow(/แก้ไขหรือลบไม่ได้/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query('DELETE FROM role_change_logs')).rejects.toThrow(/แก้ไขหรือลบไม่ได้/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query('TRUNCATE role_change_logs CASCADE')).rejects.toThrow(/แก้ไขหรือลบไม่ได้/);
    });
  });

  it('sessions.token_hash ต้องยาว 32 ไบต์ (SHA-256)', async () => {
    await inRollback(async (client) => {
      const userId = await createUser(client);
      await expect(
        client.query(
          `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
          [Buffer.alloc(16), userId],
        ),
      ).rejects.toThrow(/token_hash/);
    });
  });

  it('approved_by กับ approved_at ต้องมาคู่กัน', async () => {
    await inRollback(async (client) => {
      const userId = await createUser(client);
      await expect(client.query('UPDATE users SET approved_by = $1 WHERE id = $1', [userId])).rejects.toThrow(
        /users_approved_pair_chk/,
      );
    });
  });

  it('updated_at เปลี่ยนเองเมื่อ UPDATE (trigger set_updated_at)', async () => {
    await inRollback(async (client) => {
      const userId = await createUser(client);
      // now() คงที่ตลอด transaction จึงตั้ง updated_at ย้อนหลังก่อนแล้วดูว่า trigger ตั้งกลับเป็น now()
      await client.query(`UPDATE users SET name = 'ก่อน' WHERE id = $1`, [userId]);
      const { rows } = await client.query<{ fresh: boolean }>(
        `UPDATE users SET name = 'หลัง', updated_at = now() - interval '1 day'
         WHERE id = $1 RETURNING updated_at = now() AS fresh`,
        [userId],
      );
      expect(rows[0]!.fresh).toBe(true);
    });
  });
});

describe('กฎในฐานข้อมูล: ใบรับรอง', () => {
  async function insertCertificate(client: PoolClient, overrides: { serial?: string } = {}): Promise<string> {
    const userId = await createUser(client);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO certificates (user_id, serial_number, subject_cn, email, not_before, not_after,
                                 source, certificate_pem, fingerprint_sha256)
       VALUES ($1, $2, 'ทดสอบ', 'test@msu.ac.th', now(), now() + interval '365 days',
               'issued', '-----BEGIN CERTIFICATE-----', $3)
       RETURNING id`,
      [userId, overrides.serial ?? 'abc123', 'a'.repeat(64)],
    );
    return rows[0]!.id;
  }

  it('certificate_audit_logs แก้ไขหรือลบไม่ได้', async () => {
    await inRollback(async (client) => {
      const certificateId = await insertCertificate(client);
      await client.query(`INSERT INTO certificate_audit_logs (certificate_id, action) VALUES ($1, 'issue')`, [
        certificateId,
      ]);
      await client.query('SAVEPOINT s1');
      await expect(client.query(`UPDATE certificate_audit_logs SET reason = 'แก้'`)).rejects.toThrow(
        /แก้ไขหรือลบไม่ได้/,
      );
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query('DELETE FROM certificate_audit_logs')).rejects.toThrow(/แก้ไขหรือลบไม่ได้/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(client.query('TRUNCATE certificate_audit_logs CASCADE')).rejects.toThrow(/แก้ไขหรือลบไม่ได้/);
    });
  });

  it('serial ต้องเป็นฐาน 16 ตัวพิมพ์เล็กไม่มี 0 นำหน้า (เทียบกับ index.txt ได้หลังแปลง)', async () => {
    await inRollback(async (client) => {
      await client.query('SAVEPOINT s1');
      await expect(insertCertificate(client, { serial: 'ABC123' })).rejects.toThrow(/serial_number/);
      await client.query('ROLLBACK TO SAVEPOINT s1');
      await expect(insertCertificate(client, { serial: '0abc' })).rejects.toThrow(/serial_number/);
    });
  });

  it('เวลาและเหตุผลการเพิกถอนต้องมาคู่กัน', async () => {
    await inRollback(async (client) => {
      const certificateId = await insertCertificate(client);
      await expect(
        client.query('UPDATE certificates SET revoked_at = now() WHERE id = $1', [certificateId]),
      ).rejects.toThrow(/certificates_revoked_pair_chk/);
    });
  });
});
