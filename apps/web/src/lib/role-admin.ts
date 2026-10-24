// กำหนด role และสิทธิ์ของ role — ชนิดข้อมูลใช้ได้ทั้ง Server และ Client Component (ไม่ import โมดูลฝั่ง server)

export type RoleWithAccess = {
  id: string;
  code: string;
  nameTh: string;
  isSystem: boolean;
  isPrivileged: boolean;
  holderCount: number;
  permissionCodes: string[];
  /** ได้ทุกสิทธิ์อยู่แล้ว (API คำนวณ) — ไม่แสดงตัวแก้ไขสิทธิ์ */
  hasAllPermissions: boolean;
};

export type PermissionInfo = { code: string; descriptionTh: string };

export type RolePermissionLog = {
  id: string;
  action: 'create' | 'rename' | 'grant' | 'revoke';
  role: { code: string; nameTh: string };
  permissionCode: string | null;
  detail: Record<string, unknown> | null;
  reason: string;
  actor: { id: string; displayName: string } | null;
  createdAt: string;
};

export type RoleAdminOverview = {
  roles: RoleWithAccess[];
  permissions: PermissionInfo[];
  logs: RolePermissionLog[];
};

/** ข้อความสรุปประวัติ เช่น "ให้สิทธิ์ user:read แก่ บุคลากร" */
export function describeRoleLog(log: RolePermissionLog): string {
  switch (log.action) {
    case 'create':
      return `สร้างบทบาท ${log.role.nameTh} (${log.role.code})`;
    case 'rename':
      return `เปลี่ยนชื่อบทบาท ${String(log.detail?.from ?? '')} → ${String(log.detail?.to ?? '')}`;
    case 'grant':
      return `ให้สิทธิ์ ${log.permissionCode} แก่ ${log.role.nameTh}`;
    case 'revoke':
      return `ถอนสิทธิ์ ${log.permissionCode} จาก ${log.role.nameTh}`;
  }
}
