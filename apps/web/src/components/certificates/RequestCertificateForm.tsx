'use client';

import { InfoList, InfoRow } from '@/components/InfoList';
import { P12PasswordForm } from './P12PasswordForm';

/**
 * ฟอร์มขอใบรับรองหลัก: ผู้ใช้ตั้งรหัสผ่านของไฟล์ .p12 เอง อายุใบตามนโยบายที่ผู้ดูแลกำหนด
 * ชื่อและอีเมลในใบรับรองมาจากบัญชี (API กำหนดเอง แก้ที่นี่ไม่ได้)
 */
export function RequestCertificateForm({
  name,
  email,
  expiresAt,
}: {
  name: string;
  email: string;
  /** วันหมดอายุโดยประมาณตามนโยบายอายุใบ (จัดรูปแบบแล้ว) */
  expiresAt: string;
}) {
  return (
    <P12PasswordForm endpoint="/me/certificates" submitLabel="ขอใบรับรอง" successTitle="ออกใบรับรองเรียบร้อยแล้ว">
      <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
        <h2 className="font-display text-lg font-semibold">ข้อมูลในใบรับรอง</h2>
        <p className="mt-1 text-sm text-muted">มาจากบัญชีของคุณ หากไม่ถูกต้องกรุณาติดต่อผู้ดูแลระบบก่อนขอใบรับรอง</p>
        <InfoList className="mt-4">
          <InfoRow label="ชื่อ">{name}</InfoRow>
          <InfoRow label="อีเมล">
            <span className="break-all">{email}</span>
          </InfoRow>
          <InfoRow label="หมดอายุ">{expiresAt}</InfoRow>
        </InfoList>
      </section>
    </P12PasswordForm>
  );
}
