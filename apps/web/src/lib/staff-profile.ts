import { apiFetch } from './api-server';

/** ข้อมูลบุคลากรจาก ERP-HR (ตามที่ API GET /me/staff-profile ส่งมา) */
export type StaffProfile = {
  staffId: string;
  prefixTh: string | null;
  firstNameTh: string;
  lastNameTh: string;
  prefixEn: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  positionTh: string | null;
  facultyNameTh: string | null;
  departmentNameTh: string | null;
  programNameTh: string | null;
  orgUnitNameTh: string | null;
  syncedAt: string;
};

/** ข้อมูลบุคลากรของผู้ใช้ปัจจุบัน — null = ไม่ใช่บุคลากร หรือยังไม่เคยดึงข้อมูลจาก ERP สำเร็จ */
export async function getMyStaffProfile(): Promise<StaffProfile | null> {
  const { staffProfile } = await apiFetch<{ staffProfile: StaffProfile | null }>('/me/staff-profile');
  return staffProfile;
}
