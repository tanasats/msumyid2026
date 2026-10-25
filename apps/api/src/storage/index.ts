import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/index.js';

// ตัวครอบการเรียก S3 (Garage) — โค้ดส่วนอื่นห้ามเรียก SDK ตรง เพื่อเปลี่ยนผู้ให้บริการได้ด้วยการแก้ env (CLAUDE.md หัวข้อ 11)
// bucket เป็น private เสมอ: browser อัปโหลด/ดาวน์โหลดด้วย presigned URL อายุสั้นเท่านั้น

export type ObjectInfo = { size: number; contentType: string | null };

export type Storage = {
  /** URL ให้ browser PUT ไฟล์ตรงเข้า storage — ลงนามชนิดไฟล์ไว้ด้วย (ต้องส่ง Content-Type เดียวกัน) */
  presignUpload(key: string, input: { contentType: string; expiresInSeconds: number }): Promise<string>;
  /** URL ให้ browser ดาวน์โหลด — ตั้งชื่อไฟล์ที่ผู้ใช้เห็นผ่าน Content-Disposition */
  presignDownload(key: string, input: { fileName: string; expiresInSeconds: number }): Promise<string>;
  head(key: string): Promise<ObjectInfo | null>;
  getBuffer(key: string): Promise<Buffer>;
  getStream(key: string): Promise<Readable>;
  /** อ่านเฉพาะช่วงไบต์ [start, end) ด้วย HTTP Range — ใช้อ่าน ZIP ใหญ่โดยไม่โหลดทั้งไฟล์ */
  getRangeStream(key: string, start: number, end: number): Promise<Readable>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** ลบแล้วไม่พบก็ถือว่าสำเร็จ (ลบซ้ำได้) */
  remove(key: string): Promise<void>;
};

/** storage เรียกไม่สำเร็จ — ผู้เรียกแปลงเป็น 503 (ไม่ส่งรายละเอียดภายในออกไป) */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

/** ชื่อไฟล์ใน Content-Disposition: ASCII สำรอง + filename* แบบ UTF-8 (RFC 6266) ให้ชื่อไทยแสดงถูก */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function createClient(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
    // SDK รุ่นใหม่ใส่ checksum (CRC32) อัตโนมัติ — ใน presigned URL จะเป็น checksum ของไฟล์ว่าง ทำให้ Garage ปฏิเสธการอัปโหลด
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new StorageError('เรียกที่เก็บไฟล์ไม่สำเร็จ', { cause: err });
  }
}

function s3Storage(): Storage {
  // API เรียก storage ผ่าน endpoint ภายใน ส่วน presigned URL ต้องเซ็นด้วย host ที่ browser เข้าถึงได้จริง
  const internal = createClient(config.s3.endpoint);
  const publicClient = createClient(config.s3.publicEndpoint);
  const Bucket = config.s3.bucket;

  return {
    presignUpload: (key, { contentType, expiresInSeconds }) =>
      call(() =>
        getSignedUrl(publicClient, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), {
          expiresIn: expiresInSeconds,
          // เซ็น Content-Type ไว้ใน URL — browser อัปโหลดไฟล์ชนิดอื่นด้วย URL นี้ไม่ได้
          signableHeaders: new Set(['content-type']),
        }),
      ),
    presignDownload: (key, { fileName, expiresInSeconds }) =>
      call(() =>
        getSignedUrl(
          publicClient,
          new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: contentDisposition(fileName) }),
          { expiresIn: expiresInSeconds },
        ),
      ),
    head: async (key) => {
      try {
        const res = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType ?? null };
      } catch (err) {
        if (err instanceof NotFound || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) {
          return null;
        }
        throw new StorageError('เรียกที่เก็บไฟล์ไม่สำเร็จ', { cause: err });
      }
    },
    getBuffer: (key) =>
      call(async () => {
        const res = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) throw new Error('ไม่มีข้อมูลไฟล์');
        return Buffer.from(await res.Body.transformToByteArray());
      }),
    getStream: (key) =>
      call(async () => {
        const res = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) throw new Error('ไม่มีข้อมูลไฟล์');
        return res.Body as Readable;
      }),
    getRangeStream: (key, start, end) =>
      call(async () => {
        // HTTP Range ระบุไบต์สุดท้ายแบบรวม (inclusive)
        const res = await internal.send(new GetObjectCommand({ Bucket, Key: key, Range: `bytes=${start}-${end - 1}` }));
        if (!res.Body) throw new Error('ไม่มีข้อมูลไฟล์');
        return res.Body as Readable;
      }),
    put: (key, body, contentType) =>
      call(async () => {
        await internal.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
      }),
    remove: (key) =>
      call(async () => {
        await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
      }),
  };
}

/** ตั้ง CORS ของ bucket ให้หน้าเว็บ (origin เดียว) อัปโหลด/ดาวน์โหลดได้ — ใช้โดยสคริปต์ storage:cors */
export async function applyBucketCors(origin: string): Promise<void> {
  await createClient(config.s3.endpoint).send(
    new PutBucketCorsCommand({
      Bucket: config.s3.bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: [origin],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['content-type'],
            ExposeHeaders: ['etag'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
}

/** ตัวเดียวทั้งแอป — test แทนด้วย memory storage ผ่าน vi.spyOn (tests/helpers/storage.ts) */
export const storage: Storage = s3Storage();
