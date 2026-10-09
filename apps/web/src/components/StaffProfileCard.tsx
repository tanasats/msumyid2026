import type { StaffProfile } from '@/lib/staff-profile';
import { InfoList, InfoRow } from './InfoList';

const dateFormatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' });

/** ข้อมูลบุคลากรจาก ERP-HR — ใช้ทั้งหน้าบัญชีของฉันและหน้าจัดการผู้ใช้ */
export function StaffProfileCard({ profile, description }: { profile: StaffProfile; description?: string }) {
  const fullNameTh = [profile.prefixTh, `${profile.firstNameTh} ${profile.lastNameTh}`].filter(Boolean).join('');
  const fullNameEn = [profile.prefixEn, profile.firstNameEn, profile.lastNameEn].filter(Boolean).join(' ');

  return (
    <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
      <h2 className="font-display text-lg font-semibold">ข้อมูลบุคลากร</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}

      <InfoList className="mt-4">
        <InfoRow label="รหัสบุคลากร">
          <span className="tabular-nums">{profile.staffId}</span>
        </InfoRow>
        <InfoRow label="ชื่อ-นามสกุล">{fullNameTh}</InfoRow>
        {profile.firstNameEn && <InfoRow label="ชื่อภาษาอังกฤษ">{fullNameEn}</InfoRow>}
        {profile.positionTh && <InfoRow label="ตำแหน่ง">{profile.positionTh}</InfoRow>}
        {profile.facultyNameTh && <InfoRow label="คณะ/สำนัก">{profile.facultyNameTh}</InfoRow>}
        {profile.departmentNameTh && <InfoRow label="กอง/ฝ่าย">{profile.departmentNameTh}</InfoRow>}
        {profile.programNameTh && <InfoRow label="กลุ่มงาน/สาขา">{profile.programNameTh}</InfoRow>}
        <InfoRow label="อัปเดตล่าสุด">{dateFormatter.format(new Date(profile.syncedAt))}</InfoRow>
      </InfoList>
    </section>
  );
}
