import type { CertificateKind, RevocationReason } from '../repositories/certificate-repository.js';

// แม่แบบอีเมลแจ้งเตือน (ภาษาไทย ข้อความล้วน) — docs/design/email.md
// หลัก: ไม่ใส่ลิงก์ดาวน์โหลดหรือข้อมูลอ่อนไหว ให้ลิงก์กลับหน้าระบบแล้ว login เอง (อีเมลที่ถูกส่งต่อ/ปลอมจึงพาไปที่อื่นไม่ได้)
// params เก็บในคิว (email_outbox) — ใส่เท่าที่แม่แบบต้องใช้ ชื่อ/อีเมลผู้รับอ่านจาก users ตอนส่ง

export type EmailNotice =
  | { template: 'account_approved'; params: Record<string, never> }
  | { template: 'account_rejected'; params: { reason: string } }
  | { template: 'primary_request_approved'; params: { note: string | null } }
  | { template: 'primary_request_rejected'; params: { note: string } }
  | { template: 'supplementary_request_approved'; params: { startDate: string; endDate: string; note: string | null } }
  | { template: 'supplementary_request_rejected'; params: { note: string } }
  | { template: 'revocation_request_rejected'; params: { serialNumber: string; note: string } }
  | {
      template: 'certificate_revoked';
      params: {
        kind: CertificateKind;
        serialNumber: string;
        reason: RevocationReason;
        /** self = เจ้าของเพิกถอนเอง, admin = ผู้ดูแลเพิกถอน, request = อนุมัติคำขอเพิกถอนของเจ้าของ */
        by: 'self' | 'admin' | 'request';
        note: string | null;
      };
    }
  | { template: 'certificate_downloaded'; params: { kind: CertificateKind; serialNumber: string } }
  // ระยะที่ 2 — งานตามรอบ (services/notification-service.ts)
  | {
      template: 'certificate_expiring';
      params: { kind: CertificateKind; serialNumber: string; notAfter: string; daysBefore: number };
    }
  | { template: 'approver_digest'; params: ApproverDigestCounts }
  // MFA (docs/design/mfa.md) — หมวดความปลอดภัย ปิดไม่ได้
  | { template: 'mfa_enabled'; params: Record<string, never> }
  | { template: 'mfa_disabled'; params: Record<string, never> }
  | { template: 'mfa_recovery_code_used'; params: { remaining: number } }
  | { template: 'mfa_recovery_codes_regenerated'; params: Record<string, never> }
  | { template: 'mfa_locked'; params: { lockedUntil: string } }
  | { template: 'mfa_reset_by_admin'; params: { reason: string } };

/** จำนวนงานค้างที่ผู้รับมีสิทธิ์ดำเนินการ — คิวที่ไม่มีสิทธิ์ไม่ใส่ */
export type ApproverDigestCounts = {
  userApprovals?: number;
  primaryRequests?: number;
  supplementaryRequests?: number;
  revocationRequests?: number;
};

export type EmailTemplateName = EmailNotice['template'];

export const EMAIL_TEMPLATES: readonly EmailTemplateName[] = [
  'account_approved',
  'account_rejected',
  'primary_request_approved',
  'primary_request_rejected',
  'supplementary_request_approved',
  'supplementary_request_rejected',
  'revocation_request_rejected',
  'certificate_revoked',
  'certificate_downloaded',
  'certificate_expiring',
  'approver_digest',
  'mfa_enabled',
  'mfa_disabled',
  'mfa_recovery_code_used',
  'mfa_recovery_codes_regenerated',
  'mfa_locked',
  'mfa_reset_by_admin',
];

export type RenderedEmail = { subject: string; text: string };

/**
 * หมวดการแจ้งเตือน (docs/design/notifications.md) — ผู้ใช้เปิด/ปิดได้เฉพาะ OPTIONAL_CATEGORIES
 * account = ผลการอนุมัติบัญชี (ส่งอีเมลเสมอ — ผู้ใช้ยังเข้าระบบมาตั้งค่าไม่ได้), security = ใบถูกเพิกถอน/ดาวน์โหลดใหม่ (ปิดไม่ได้ —
 * ผู้ที่แอบเข้าบัญชีต้องปิดการเตือนนี้ไม่ได้)
 */
export type NotificationCategory = 'account' | 'decisions' | 'security' | 'expiry' | 'approver_digest';
export const OPTIONAL_CATEGORIES = ['decisions', 'expiry', 'approver_digest'] as const;
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];

export const NOTICE_CATEGORIES: Record<EmailTemplateName, NotificationCategory> = {
  account_approved: 'account',
  account_rejected: 'account',
  primary_request_approved: 'decisions',
  primary_request_rejected: 'decisions',
  supplementary_request_approved: 'decisions',
  supplementary_request_rejected: 'decisions',
  revocation_request_rejected: 'decisions',
  certificate_revoked: 'security',
  certificate_downloaded: 'security',
  certificate_expiring: 'expiry',
  approver_digest: 'approver_digest',
  mfa_enabled: 'security',
  mfa_disabled: 'security',
  mfa_recovery_code_used: 'security',
  mfa_recovery_codes_regenerated: 'security',
  mfa_locked: 'security',
  mfa_reset_by_admin: 'security',
};

/** แม่แบบที่ส่งทางอีเมลอย่างเดียว — สรุปงานรายวันในระบบไม่มีประโยชน์ (ตัวเลขงานค้างดูที่เมนูแทน) */
export const EMAIL_ONLY_TEMPLATES: readonly EmailTemplateName[] = ['approver_digest'];

export function isOptionalCategory(category: NotificationCategory): category is OptionalCategory {
  return (OPTIONAL_CATEGORIES as readonly string[]).includes(category);
}

const KIND_LABELS: Record<CertificateKind, string> = {
  primary: 'ใบรับรองประจำตัว',
  supplementary: 'ใบรับรองเสริม',
};

// ข้อความเดียวกับหน้าเว็บ (apps/web/src/lib/verify.ts)
const REASON_LABELS: Record<RevocationReason, string> = {
  keyCompromise: 'key อาจหลุดไปถึงผู้อื่น',
  CACompromise: 'CA ถูกบุกรุก',
  affiliationChanged: 'ข้อมูลในใบรับรองไม่ถูกต้อง / ย้ายสังกัด',
  superseded: 'ออกใบใหม่แทนแล้ว',
  cessationOfOperation: 'เลิกใช้งาน / พ้นสภาพ',
  unspecified: 'ไม่ระบุ',
};

const SYSTEM_NAME = 'MSU Digital ID';

/** serial แสดงเป็นฐาน 16 ตัวพิมพ์ใหญ่ เหมือนหน้าเว็บ */
const serial = (value: string) => value.toUpperCase();

/** วันที่ (YYYY-MM-DD ตามเวลาไทย) → "1 พฤศจิกายน 2569" */
function thaiDate(isoDate: string): string {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(
    new Date(`${isoDate}T00:00:00+07:00`),
  );
}

/** เวลา (ISO) → วันที่ภาษาไทยตามเวลาไทย */
function thaiDateTime(iso: string): string {
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(iso));
}

// คิวในสรุปงาน — ลิงก์เดียวกับส่วน "รอดำเนินการ" ของหน้า /admin
const DIGEST_QUEUES: { key: keyof ApproverDigestCounts; label: string; path: string }[] = [
  { key: 'userApprovals', label: 'บัญชีรออนุมัติ', path: '/admin/users?status=pending' },
  { key: 'primaryRequests', label: 'คำขอใบรับรองประจำตัว', path: '/admin/certificate-requests?type=primary' },
  { key: 'supplementaryRequests', label: 'คำขอใบรับรองเสริม', path: '/admin/certificate-requests?type=supplementary' },
  { key: 'revocationRequests', label: 'คำขอเพิกถอนใบรับรอง', path: '/admin/certificate-requests?type=revocation' },
];

/** ส่วนความปลอดภัยของบัญชีในหน้าบัญชีของฉัน */
const MFA_PATH = '/account#security';
const MFA_NOT_YOU = ['', 'ถ้าคุณไม่ได้ทำเอง แปลว่าอาจมีผู้อื่นเข้าบัญชีของคุณได้ ให้เปลี่ยนรหัสผ่านบัญชี Google และแจ้งผู้ดูแลระบบทันที'];

function noteLine(label: string, note: string | null): string[] {
  return note ? ['', `${label}: ${note}`] : [];
}

function baseBody(input: {
  name: string | null;
  lines: string[];
  link: { label: string; url: string };
  /** หมวดที่ปิดได้ — บอกทางปิด */
  preferencesUrl: string | null;
}): string {
  return [
    `เรียน ${input.name ?? 'ผู้ใช้งาน'}`,
    '',
    ...input.lines,
    '',
    `${input.link.label}: ${input.link.url}`,
    '',
    '--',
    ...(input.preferencesUrl ? [`เปิด/ปิดการแจ้งเตือนประเภทนี้ได้ที่: ${input.preferencesUrl}`] : []),
    `อีเมลฉบับนี้ส่งอัตโนมัติจากระบบ ${SYSTEM_NAME} มหาวิทยาลัยมหาสารคาม`,
  ].join('\n');
}

export function renderEmail(notice: EmailNotice, ctx: { recipientName: string | null; webUrl: string }): RenderedEmail {
  const url = (path: string) => new URL(path, ctx.webUrl).toString();
  const certificatesLink = { label: 'ดูใบรับรองของคุณ', url: url('/certificates') };
  const mfaLink = { label: 'ดูการตั้งค่าความปลอดภัยของบัญชี', url: url(MFA_PATH) };
  const name = ctx.recipientName;
  const preferencesUrl = isOptionalCategory(NOTICE_CATEGORIES[notice.template]) ? url('/account#notifications') : null;
  const body = (input: { name: string | null; lines: string[]; link: { label: string; url: string } }) =>
    baseBody({ ...input, preferencesUrl });

  switch (notice.template) {
    case 'account_approved':
      return {
        subject: `บัญชี ${SYSTEM_NAME} ของคุณได้รับอนุมัติแล้ว`,
        text: body({
          name,
          lines: ['บัญชีของคุณได้รับอนุมัติแล้ว เข้าสู่ระบบเพื่อขอใบรับรองดิจิทัลได้ทันที'],
          link: { label: 'เข้าสู่ระบบ', url: url('/') },
        }),
      };
    case 'account_rejected':
      return {
        subject: `บัญชี ${SYSTEM_NAME} ของคุณไม่ได้รับอนุมัติ`,
        text: body({
          name,
          lines: ['บัญชีของคุณไม่ได้รับอนุมัติให้ใช้งานระบบ', ...noteLine('เหตุผล', notice.params.reason)],
          link: { label: 'ดูรายละเอียด', url: url('/') },
        }),
      };
    case 'primary_request_approved':
      return {
        subject: 'คำขอใบรับรองประจำตัวได้รับอนุมัติแล้ว',
        text: body({
          name,
          lines: [
            'คำขอใบรับรองประจำตัวของคุณได้รับอนุมัติแล้ว เข้าสู่ระบบเพื่อตั้งรหัสผ่านไฟล์และรับใบรับรอง',
            ...noteLine('บันทึกจากผู้อนุมัติ', notice.params.note),
          ],
          link: { label: 'รับใบรับรอง', url: url('/certificates') },
        }),
      };
    case 'primary_request_rejected':
      return {
        subject: 'คำขอใบรับรองประจำตัวไม่ได้รับอนุมัติ',
        text: body({
          name,
          lines: ['คำขอใบรับรองประจำตัวของคุณไม่ได้รับอนุมัติ', ...noteLine('เหตุผล', notice.params.note)],
          link: certificatesLink,
        }),
      };
    case 'supplementary_request_approved':
      return {
        subject: 'คำขอใบรับรองเสริมได้รับอนุมัติแล้ว',
        text: body({
          name,
          lines: [
            `คำขอใบรับรองเสริมของคุณได้รับอนุมัติแล้ว ใช้งานได้ตั้งแต่ ${thaiDate(notice.params.startDate)} ถึง ${thaiDate(notice.params.endDate)}`,
            'เข้าสู่ระบบเพื่อตั้งรหัสผ่านไฟล์และรับใบรับรอง',
            ...noteLine('บันทึกจากผู้อนุมัติ', notice.params.note),
          ],
          link: { label: 'รับใบรับรอง', url: url('/certificates') },
        }),
      };
    case 'supplementary_request_rejected':
      return {
        subject: 'คำขอใบรับรองเสริมไม่ได้รับอนุมัติ',
        text: body({
          name,
          lines: ['คำขอใบรับรองเสริมของคุณไม่ได้รับอนุมัติ', ...noteLine('เหตุผล', notice.params.note)],
          link: certificatesLink,
        }),
      };
    case 'revocation_request_rejected':
      return {
        subject: 'คำขอเพิกถอนใบรับรองไม่ได้รับอนุมัติ',
        text: body({
          name,
          lines: [
            `คำขอเพิกถอนใบรับรองประจำตัวหมายเลข ${serial(notice.params.serialNumber)} ไม่ได้รับอนุมัติ ใบรับรองยังใช้งานได้ตามปกติ`,
            ...noteLine('เหตุผล', notice.params.note),
          ],
          link: certificatesLink,
        }),
      };
    case 'certificate_revoked': {
      const { kind, by } = notice.params;
      const lead =
        by === 'request'
          ? `คำขอเพิกถอนของคุณได้รับอนุมัติแล้ว ${KIND_LABELS[kind]}หมายเลข ${serial(notice.params.serialNumber)} ถูกเพิกถอนแล้ว`
          : by === 'admin'
            ? `ผู้ดูแลระบบเพิกถอน${KIND_LABELS[kind]}หมายเลข ${serial(notice.params.serialNumber)} ของคุณแล้ว`
            : `${KIND_LABELS[kind]}หมายเลข ${serial(notice.params.serialNumber)} ของคุณถูกเพิกถอนแล้ว`;
      return {
        subject: `${KIND_LABELS[kind]}ของคุณถูกเพิกถอนแล้ว`,
        text: body({
          name,
          lines: [
            lead,
            `เหตุผล: ${REASON_LABELS[notice.params.reason]}`,
            ...noteLine('บันทึกจากผู้ดูแล', by === 'self' ? null : notice.params.note),
            '',
            'ลายมือชื่อที่ลงด้วยใบนี้หลังจากนี้จะตรวจไม่ผ่าน ถ้ายังต้องใช้งาน ให้ขอใบรับรองใหม่',
            ...(by === 'self' ? ['ถ้าคุณไม่ได้เพิกถอนเอง ให้แจ้งผู้ดูแลระบบทันที'] : []),
          ],
          link: certificatesLink,
        }),
      };
    }
    case 'certificate_expiring': {
      const { kind, daysBefore } = notice.params;
      return {
        subject: `${KIND_LABELS[kind]}ของคุณจะหมดอายุในอีก ${daysBefore} วัน`,
        text: body({
          name,
          lines: [
            `${KIND_LABELS[kind]}หมายเลข ${serial(notice.params.serialNumber)} จะหมดอายุ ${thaiDateTime(notice.params.notAfter)}`,
            '',
            kind === 'primary'
              ? 'ขอใบใหม่เพื่อต่ออายุได้ที่หน้าใบรับรองของฉัน (หน้าเว็บบอกวันที่เริ่มต่ออายุได้) ใบเดิมยังใช้ได้จนถึงวันหมดอายุ'
              : 'ถ้ายังต้องใช้หลังวันนั้น ให้ส่งคำขอใบรับรองเสริมใบใหม่ที่หน้าใบรับรองของฉัน',
            'เอกสารที่ลงนามไว้ก่อนใบหมดอายุยังตรวจสอบได้ตามปกติ',
          ],
          link: certificatesLink,
        }),
      };
    }
    case 'approver_digest': {
      const queues = DIGEST_QUEUES.filter((q) => (notice.params[q.key] ?? 0) > 0);
      const total = queues.reduce((sum, q) => sum + notice.params[q.key]!, 0);
      return {
        subject: `มีงานรอดำเนินการ ${total} รายการในระบบ ${SYSTEM_NAME}`,
        text: body({
          name,
          lines: [
            'งานที่รอคุณดำเนินการ ณ เช้าวันนี้:',
            '',
            ...queues.map((q) => `- ${q.label} ${notice.params[q.key]} รายการ: ${url(q.path)}`),
            '',
            'คุณได้รับสรุปนี้ทุกเช้าวันทำการที่มีงานค้าง เพราะมีสิทธิ์พิจารณางานข้างต้น',
          ],
          link: { label: 'เปิดระบบ', url: url('/') },
        }),
      };
    }
    case 'certificate_downloaded':
      return {
        subject: `มีการดาวน์โหลด${KIND_LABELS[notice.params.kind]}ของคุณ`,
        text: body({
          name,
          lines: [
            `มีการดาวน์โหลดไฟล์${KIND_LABELS[notice.params.kind]}หมายเลข ${serial(notice.params.serialNumber)} ด้วยรหัสผ่านไฟล์ใหม่จากบัญชีของคุณ`,
            '',
            'ถ้าคุณทำเอง ไม่ต้องทำอะไรเพิ่ม',
            'ถ้าคุณไม่ได้ทำ แปลว่าอาจมีผู้อื่นเข้าบัญชีของคุณได้ ให้เปลี่ยนรหัสผ่านของบัญชีที่ใช้เข้าสู่ระบบ แล้วเพิกถอนใบรับรองนี้ด้วยเหตุผล "key อาจหลุดไปถึงผู้อื่น" ทันที',
          ],
          link: certificatesLink,
        }),
      };
    case 'mfa_enabled':
      return {
        subject: 'เปิดการยืนยันตัวตนสองขั้นตอนแล้ว',
        text: body({
          name,
          lines: [
            'บัญชีของคุณเปิดการยืนยันตัวตนสองขั้นตอน (รหัสจากแอป Authenticator) แล้ว',
            'เก็บรหัสกู้คืนไว้ในที่ปลอดภัย ใช้แทนรหัสจากแอปได้เมื่อโทรศัพท์หาย',
            ...MFA_NOT_YOU,
          ],
          link: mfaLink,
        }),
      };
    case 'mfa_disabled':
      return {
        subject: 'ปิดการยืนยันตัวตนสองขั้นตอนแล้ว',
        text: body({
          name,
          lines: ['บัญชีของคุณปิดการยืนยันตัวตนสองขั้นตอนแล้ว การเข้าสู่ระบบจะใช้เฉพาะบัญชี Google', ...MFA_NOT_YOU],
          link: mfaLink,
        }),
      };
    case 'mfa_recovery_code_used':
      return {
        subject: 'มีการใช้รหัสกู้คืนของบัญชีคุณ',
        text: body({
          name,
          lines: [
            `มีการใช้รหัสกู้คืนแทนรหัสจากแอป Authenticator เหลือรหัสกู้คืนที่ยังไม่ใช้ ${notice.params.remaining} รหัส`,
            ...(notice.params.remaining <= 3 ? ['รหัสใกล้หมดแล้ว ออกรหัสกู้คืนชุดใหม่ได้ที่หน้าบัญชีของฉัน'] : []),
            ...MFA_NOT_YOU,
          ],
          link: mfaLink,
        }),
      };
    case 'mfa_recovery_codes_regenerated':
      return {
        subject: 'ออกรหัสกู้คืนชุดใหม่แล้ว',
        text: body({
          name,
          lines: ['มีการออกรหัสกู้คืนชุดใหม่ให้บัญชีของคุณ รหัสชุดเดิมใช้ไม่ได้แล้ว', ...MFA_NOT_YOU],
          link: mfaLink,
        }),
      };
    case 'mfa_reset_by_admin':
      return {
        subject: 'ผู้ดูแลระบบรีเซ็ตการยืนยันตัวตนสองขั้นตอนของคุณ',
        text: body({
          name,
          lines: [
            'ผู้ดูแลระบบลบการตั้งค่าการยืนยันตัวตนสองขั้นตอนของบัญชีคุณ และออกจากระบบทุกอุปกรณ์แล้ว',
            `เหตุผล: ${notice.params.reason}`,
            '',
            'เข้าสู่ระบบอีกครั้งแล้วตั้งค่าใหม่ด้วยแอป Authenticator ในโทรศัพท์เครื่องปัจจุบัน',
            ...MFA_NOT_YOU,
          ],
          link: mfaLink,
        }),
      };
    case 'mfa_locked':
      return {
        subject: 'ใส่รหัสยืนยันตัวตนผิดหลายครั้ง',
        text: body({
          name,
          lines: [
            `มีการใส่รหัสยืนยันตัวตนสองขั้นตอนผิดหลายครั้ง ระบบระงับการใส่รหัสไว้ถึง ${thaiDateTime(notice.params.lockedUntil)}`,
            '',
            'ถ้าไม่ใช่คุณ แปลว่ามีผู้อื่นเข้าบัญชี Google ของคุณได้แล้ว ให้เปลี่ยนรหัสผ่านบัญชี Google ทันที',
          ],
          link: mfaLink,
        }),
      };
  }
}

export type RenderedInAppNotification = { title: string; body: string; href: string };

/** ข้อความของการแจ้งเตือนในระบบ (สั้นกว่าอีเมล ไม่มีคำขึ้นต้น) — href = หน้าในระบบที่เกี่ยวข้อง */
export function renderInAppNotification(notice: EmailNotice): RenderedInAppNotification {
  const withNote = (text: string, label: string, note: string | null) => (note ? `${text} — ${label}: ${note}` : text);
  switch (notice.template) {
    case 'account_approved':
      return { title: 'บัญชีได้รับอนุมัติแล้ว', body: 'ขอใบรับรองดิจิทัลได้ทันที', href: '/certificates' };
    case 'account_rejected':
      return { title: 'บัญชีไม่ได้รับอนุมัติ', body: `เหตุผล: ${notice.params.reason}`, href: '/' };
    case 'primary_request_approved':
      return {
        title: 'คำขอใบรับรองประจำตัวได้รับอนุมัติ',
        body: withNote('ตั้งรหัสผ่านไฟล์และรับใบรับรองได้แล้ว', 'บันทึก', notice.params.note),
        href: '/certificates',
      };
    case 'primary_request_rejected':
      return { title: 'คำขอใบรับรองประจำตัวไม่ได้รับอนุมัติ', body: `เหตุผล: ${notice.params.note}`, href: '/certificates' };
    case 'supplementary_request_approved':
      return {
        title: 'คำขอใบรับรองเสริมได้รับอนุมัติ',
        body: withNote(
          `ใช้งานได้ ${thaiDate(notice.params.startDate)} – ${thaiDate(notice.params.endDate)} รับใบรับรองได้แล้ว`,
          'บันทึก',
          notice.params.note,
        ),
        href: '/certificates',
      };
    case 'supplementary_request_rejected':
      return { title: 'คำขอใบรับรองเสริมไม่ได้รับอนุมัติ', body: `เหตุผล: ${notice.params.note}`, href: '/certificates' };
    case 'revocation_request_rejected':
      return {
        title: 'คำขอเพิกถอนไม่ได้รับอนุมัติ',
        body: `ใบหมายเลข ${serial(notice.params.serialNumber)} ยังใช้งานได้ — เหตุผล: ${notice.params.note}`,
        href: '/certificates',
      };
    case 'certificate_revoked': {
      const { kind, by } = notice.params;
      const who = by === 'admin' ? 'ผู้ดูแลระบบเพิกถอน' : by === 'request' ? 'อนุมัติคำขอเพิกถอนแล้ว' : 'เพิกถอนแล้ว';
      return {
        title: `${KIND_LABELS[kind]}ถูกเพิกถอน`,
        body: withNote(
          `หมายเลข ${serial(notice.params.serialNumber)} ${who} (${REASON_LABELS[notice.params.reason]})`,
          'บันทึก',
          by === 'self' ? null : notice.params.note,
        ),
        href: '/certificates',
      };
    }
    case 'certificate_downloaded':
      return {
        title: `มีการดาวน์โหลด${KIND_LABELS[notice.params.kind]}`,
        body: `หมายเลข ${serial(notice.params.serialNumber)} ถ้าคุณไม่ได้ทำเอง ให้เพิกถอนใบนี้ทันที`,
        href: '/certificates',
      };
    case 'certificate_expiring':
      return {
        title: `${KIND_LABELS[notice.params.kind]}จะหมดอายุในอีก ${notice.params.daysBefore} วัน`,
        body: `หมายเลข ${serial(notice.params.serialNumber)} หมดอายุ ${thaiDateTime(notice.params.notAfter)}`,
        href: '/certificates',
      };
    case 'approver_digest':
      // ไม่สร้างในระบบ (EMAIL_ONLY_TEMPLATES) — กรณีนี้มีไว้ให้ครบทุกแม่แบบ
      return { title: 'มีงานรอดำเนินการ', body: 'ดูคิวงานที่หน้าจัดการระบบ', href: '/admin' };
    case 'mfa_enabled':
      return { title: 'เปิดการยืนยันตัวตนสองขั้นตอนแล้ว', body: 'ถ้าคุณไม่ได้ทำเอง ให้แจ้งผู้ดูแลระบบทันที', href: MFA_PATH };
    case 'mfa_disabled':
      return { title: 'ปิดการยืนยันตัวตนสองขั้นตอนแล้ว', body: 'ถ้าคุณไม่ได้ทำเอง ให้แจ้งผู้ดูแลระบบทันที', href: MFA_PATH };
    case 'mfa_recovery_code_used':
      return {
        title: 'มีการใช้รหัสกู้คืน',
        body: `เหลือรหัสกู้คืน ${notice.params.remaining} รหัส ถ้าคุณไม่ได้ทำเอง ให้แจ้งผู้ดูแลระบบทันที`,
        href: MFA_PATH,
      };
    case 'mfa_recovery_codes_regenerated':
      return { title: 'ออกรหัสกู้คืนชุดใหม่แล้ว', body: 'รหัสชุดเดิมใช้ไม่ได้แล้ว', href: MFA_PATH };
    case 'mfa_reset_by_admin':
      return {
        title: 'ผู้ดูแลระบบรีเซ็ตการยืนยันตัวตนสองขั้นตอน',
        body: `เหตุผล: ${notice.params.reason} — ตั้งค่าใหม่ได้ที่หน้าบัญชีของฉัน`,
        href: MFA_PATH,
      };
    case 'mfa_locked':
      return {
        title: 'ใส่รหัสยืนยันตัวตนผิดหลายครั้ง',
        body: `ระงับการใส่รหัสถึง ${thaiDateTime(notice.params.lockedUntil)} ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่านบัญชี Google ทันที`,
        href: MFA_PATH,
      };
  }
}
