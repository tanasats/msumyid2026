import type { Queryable } from '../db/types.js';

// ตาราง files — แถวต่อ 1 object ใน storage (CLAUDE.md หัวข้อ 11)

export type FilePurpose = 'signing_source' | 'signing_result' | 'signature_image';

export type FileRow = {
  id: string;
  bucket: string;
  objectKey: string;
  purpose: FilePurpose;
  originalName: string;
  mimeType: string;
  size: number;
  sha256: string | null;
  status: 'pending' | 'uploaded';
  uploadedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
};

const COLUMNS = `id,
            bucket,
            object_key    AS "objectKey",
            purpose,
            original_name AS "originalName",
            mime_type     AS "mimeType",
            size::float8  AS size,
            sha256,
            status,
            uploaded_by   AS "uploadedBy",
            expires_at    AS "expiresAt",
            created_at    AS "createdAt"`;

export async function insertFile(
  db: Queryable,
  input: {
    bucket: string;
    objectKey: string;
    purpose: FilePurpose;
    originalName: string;
    mimeType: string;
    size: number;
    status: 'pending' | 'uploaded';
    sha256?: string | null;
    uploadedBy: string;
    expiresAt: Date | null;
  },
): Promise<FileRow> {
  const result = await db.query<FileRow>(
    `INSERT INTO files (bucket, object_key, purpose, original_name, mime_type, size, status, sha256, uploaded_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [
      input.bucket,
      input.objectKey,
      input.purpose,
      input.originalName,
      input.mimeType,
      input.size,
      input.status,
      input.sha256 ?? null,
      input.uploadedBy,
      input.expiresAt,
    ],
  );
  return result.rows[0]!;
}

/** ไฟล์ที่ยังไม่ถูกลบ (deleted_at IS NULL) */
export async function findFileById(db: Queryable, id: string): Promise<FileRow | null> {
  const result = await db.query<FileRow>(`SELECT ${COLUMNS} FROM files WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return result.rows[0] ?? null;
}

/** ยืนยันว่าอัปโหลดแล้ว — เงื่อนไข status = 'pending' กันยืนยันซ้ำ คืน false ถ้าไม่ได้แก้ */
export async function markFileUploaded(db: Queryable, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE files SET status = 'uploaded' WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL`,
    [id],
  );
  return result.rowCount === 1;
}

export async function setFileSha256(db: Queryable, id: string, sha256: string): Promise<void> {
  await db.query(`UPDATE files SET sha256 = $2 WHERE id = $1`, [id, sha256]);
}

/** ตั้งให้หมดอายุตอนนี้ (job จะลบ object) — ใช้กับไฟล์ที่ไม่ผ่านการตรวจ หรือผู้ใช้ถูกลบบัญชี */
export async function expireFile(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE files SET expires_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
}

/**
 * ไฟล์ที่หมดอายุแล้วแต่ยังไม่ลบ เก่าก่อน (ใช้ partial index files_expires_at_idx)
 * FOR UPDATE SKIP LOCKED: job หลายตัว (เช่น API หลาย instance) ไม่หยิบไฟล์เดียวกัน
 */
export async function lockExpiredFiles(db: Queryable, limit: number): Promise<Pick<FileRow, 'id' | 'bucket' | 'objectKey'>[]> {
  const result = await db.query<Pick<FileRow, 'id' | 'bucket' | 'objectKey'>>(
    `SELECT id, bucket, object_key AS "objectKey"
     FROM files
     WHERE deleted_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at <= now()
     ORDER BY expires_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows;
}

export async function markFileDeleted(db: Queryable, id: string): Promise<void> {
  await db.query(`UPDATE files SET deleted_at = now() WHERE id = $1`, [id]);
}

/**
 * ลบบัญชี (PDPA): ล้างชื่อไฟล์ต้นฉบับ และให้ไฟล์ทั้งหมดของผู้ใช้หมดอายุทันที (job ลบ object ภายในรอบถัดไป)
 * คืนจำนวนไฟล์ที่ตั้งให้ลบ
 */
export async function expireFilesOfUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query(
    `UPDATE files
     SET original_name = 'deleted', expires_at = now()
     WHERE uploaded_by = $1
       AND deleted_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}
