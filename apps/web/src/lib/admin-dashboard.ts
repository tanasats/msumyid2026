import { apiFetch } from './api-server';

// หน้า "จัดการระบบ" (/admin) — API คืนเฉพาะหมวดที่ผู้เรียกมีสิทธิ์ (หมวดที่ไม่มีสิทธิ์ = null / ไม่มี key)

/** ok = ปกติ, warning = ต้องตรวจ, error = ใช้งานไม่ได้ */
export type HealthLevel = 'ok' | 'warning' | 'error';

export type Dashboard = {
  windowDays: number;
  pending: {
    userApprovals?: number;
    primaryRequests?: number;
    supplementaryRequests?: number;
    revocationRequests?: number;
  };
  users: { active: number; createdSince: number; unclassified: number; inactive: number } | null;
  certificates: {
    activePrimary: number;
    activeSupplementary: number;
    expiringSoon: number;
    issuedSince: number;
    revokedSince: number;
  } | null;
  system: {
    signer: HealthLevel;
    crl: { level: HealthLevel; crlNumber: string | null; thisUpdate: string | null; nextUpdate: string | null };
    signingQueue: { level: HealthLevel; pending: number; signing: number; oldestOpenAt: string | null; failedLast24h: number };
  } | null;
};

export async function getDashboard(): Promise<Dashboard> {
  return apiFetch('/admin/dashboard');
}
