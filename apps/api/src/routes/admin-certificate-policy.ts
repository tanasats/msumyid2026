import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middlewares/auth.js';
import { changeCertificatePolicy, getCertificatePolicyForAdmin } from '../services/certificate-policy-service.js';
import { PERMISSIONS } from '../services/permissions.js';

export const adminCertificatePolicyRouter = Router();

// ช่วงค่าตรงกับ CHECK ใน migration create-certificate-policies-table และ add-supplementary-max-lead-days
const policyBody = z.object({
  primaryMode: z.enum(['days', 'fixed_date']),
  primaryDays: z.number().int().min(1).max(825),
  primaryExpiryMonth: z.number().int().min(1).max(12),
  primaryExpiryDay: z.number().int().min(1).max(31),
  primaryMinDays: z.number().int().min(0).max(365),
  renewalWindowDays: z.number().int().min(0).max(365),
  supplementaryMaxDays: z.number().int().min(1).max(825),
  supplementaryMaxActive: z.number().int().min(0).max(20),
  supplementaryMaxLeadDays: z.number().int().min(0).max(365),
});

// สิทธิ์: certificate_policy:manage — ดูนโยบายอายุใบรับรอง ตัวอย่างวันหมดอายุ และประวัติการแก้
adminCertificatePolicyRouter.get(
  '/admin/certificate-policy',
  requirePermission(PERMISSIONS.CERTIFICATE_POLICY_MANAGE),
  async (_req, res) => {
    res.json(await getCertificatePolicyForAdmin());
  },
);

// สิทธิ์: certificate_policy:manage — แก้นโยบาย (มีผลกับใบที่ออกหลังจากนี้เท่านั้น)
adminCertificatePolicyRouter.put(
  '/admin/certificate-policy',
  requirePermission(PERMISSIONS.CERTIFICATE_POLICY_MANAGE),
  async (req, res) => {
    const settings = policyBody.parse(req.body);
    await changeCertificatePolicy(req.user!, settings);
    res.json(await getCertificatePolicyForAdmin());
  },
);
