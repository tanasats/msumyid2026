import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from './api-server';
import type { ResponsibleUser } from './account-type';
import type { CurrentUser } from './auth';
import type { StaffProfile } from './staff-profile';

// ข้อมูลหน้าจัดการบัญชีผู้ใช้ (ตามที่ API /admin/* ส่งมา) — เรียกจาก Server Component เท่านั้น

export type AccountType = CurrentUser['accountType'];
export type ApprovalStatus = CurrentUser['approvalStatus'];
export type UserStatusFilter = 'active' | 'pending' | 'rejected' | 'inactive';

export type UserListItem = {
  id: string;
  email: string;
  displayName: string;
  pictureUrl: string | null;
  accountType: AccountType;
  approvalStatus: ApprovalStatus;
  isActive: boolean;
  orgUnitNameTh: string | null;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
};

export type UserRole = { code: string; nameTh: string; isSystem: boolean; isPrivileged: boolean; grantedAt: string };

export type UserHistoryItem = {
  id: string;
  kind: 'user' | 'role';
  action: string;
  roleNameTh: string | null;
  changes: Record<string, unknown>;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
};

export type UserDetail = {
  user: {
    id: string;
    email: string;
    displayName: string;
    googleName: string;
    pictureUrl: string | null;
    accountType: AccountType;
    approvalStatus: ApprovalStatus;
    isActive: boolean;
    hasGoogleAccount: boolean;
    orgUnitId: string | null;
    orgUnitNameTh: string | null;
    /** ชื่อที่ผู้ดูแลกำหนดเอง (null = ใช้ชื่อจาก ERP/Google) */
    displayNameOverride: string | null;
    lastLoginAt: string | null;
    createdAt: string;
    approvedAt: string | null;
    approvedByName: string | null;
    deactivatedAt: string | null;
    deactivatedByName: string | null;
    /** วันหมดอายุของบัญชีหน่วยงาน — null = ไม่หมดอายุ */
    accountExpiresAt: string | null;
    responsibleUser: ResponsibleUser | null;
    roles: UserRole[];
  };
  staffProfile: StaffProfile | null;
  history: UserHistoryItem[];
  manageable: boolean;
  isSelf: boolean;
};

export type AssignableRole = {
  code: string;
  nameTh: string;
  isSystem: boolean;
  isPrivileged: boolean;
  assignable: boolean;
};

export type UserListQuery = {
  q?: string;
  status?: UserStatusFilter;
  accountType?: AccountType;
  cursor?: string;
};

/** API ตอบ 403 → ไปหน้า "ไม่มีสิทธิ์เข้าถึง" (การตรวจสิทธิ์จริงอยู่ที่ API) */
async function adminFetch<T>(path: string): Promise<T> {
  try {
    return await apiFetch<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) redirect('/forbidden');
    throw err;
  }
}

export function listUsers(query: UserListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  return adminFetch<{ users: UserListItem[]; nextCursor: string | null }>(`/admin/users?${params}`);
}

/** null = ไม่พบผู้ใช้ (ให้หน้าแสดง not found) */
export async function getUserDetail(id: string): Promise<UserDetail | null> {
  try {
    return await adminFetch<UserDetail>(`/admin/users/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

export async function listAssignableRoles(): Promise<AssignableRole[]> {
  const { roles } = await adminFetch<{ roles: AssignableRole[] }>('/admin/roles');
  return roles;
}

export type OrgUnit = { id: string; code: string; nameTh: string };

export async function listOrgUnits(): Promise<OrgUnit[]> {
  const { orgUnits } = await adminFetch<{ orgUnits: OrgUnit[] }>('/admin/org-units');
  return orgUnits;
}
