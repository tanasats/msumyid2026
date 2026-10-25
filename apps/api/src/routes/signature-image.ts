import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { PERMISSIONS } from '../services/permissions.js';
import { deleteMySignatureImage, getMySignatureImage, setMySignatureImage } from '../services/signature-image-service.js';

// ภาพลายเซ็นของผู้ใช้ (docs/design/document-signing.md ระยะ D2) — อัปโหลดไฟล์ผ่าน /me/files (purpose signature_image) ก่อน
export const signatureImageRouter = Router();

const setBody = z.object({ fileId: z.uuid() });

// สิทธิ์: document:sign — ภาพปัจจุบัน + URL แสดงภาพอายุ 5 นาที (null = ยังไม่ได้ตั้ง)
signatureImageRouter.get('/me/signature-image', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ image: await getMySignatureImage(req.user!) });
});

// สิทธิ์: document:sign — ตั้ง/เปลี่ยนภาพจากไฟล์ PNG ที่อัปโหลดแล้ว (ภาพเดิมถูกลบ)
signatureImageRouter.put('/me/signature-image', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  const { fileId } = setBody.parse(req.body);
  res.json({ image: await setMySignatureImage(req.user!, fileId) });
});

// สิทธิ์: document:sign — ลบภาพลายเซ็น
signatureImageRouter.delete('/me/signature-image', requirePermission(PERMISSIONS.DOCUMENT_SIGN), async (req, res) => {
  await deleteMySignatureImage(req.user!);
  res.status(204).end();
});
