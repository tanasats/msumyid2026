import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { notify, purgeOldNotifications } from '../src/services/user-notification-service.js';
import { queueApproverDigest } from '../src/services/notification-service.js';
import { createTestRole, createUser, loginAs, queuedEmails, resetDatabase } from './helpers/db.js';

// การแจ้งเตือนในระบบ + การตั้งค่า (docs/design/notifications.md) — ฐานข้อมูลจริง app_test

const app = createApp();
const ORIGIN = 'http://localhost:3010';

beforeEach(async () => {
  await resetDatabase();
  await pool.query('TRUNCATE notification_runs');
});

afterAll(async () => {
  await resetDatabase();
  await pool.query('TRUNCATE notification_runs');
  await pool.end();
});

async function inAppTemplates(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ template: string }>(
    `SELECT template FROM notifications WHERE user_id = $1 ORDER BY id`,
    [userId],
  );
  return rows.map((r) => r.template);
}

const decision = { template: 'primary_request_rejected', params: { note: 'ยังไม่ผ่านการตรวจสอบ' } } as const;
const security = {
  template: 'certificate_downloaded',
  params: { kind: 'primary', serialNumber: '1abc' },
} as const;

async function setPreference(cookie: string, body: object) {
  return request(app).put('/me/notification-preferences').set('Cookie', cookie).set('Origin', ORIGIN).send(body);
}

describe('notify ตามการตั้งค่า', () => {
  it('ค่าเริ่มต้น: แจ้งทั้งในระบบและอีเมล', async () => {
    const user = await createUser();
    expect(await notify(pool, user.id, decision)).toEqual({ inApp: true, email: true });
    expect(await inAppTemplates(user.id)).toEqual(['primary_request_rejected']);
    expect((await queuedEmails(user.id)).map((e) => e.template)).toEqual(['primary_request_rejected']);
  });

  it('ปิดอีเมลของหมวดผลการพิจารณา → ในระบบอย่างเดียว / ปิดในระบบ → อีเมลอย่างเดียว', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    expect((await setPreference(cookie, { category: 'decisions', inApp: true, email: false })).status).toBe(200);
    await notify(pool, user.id, decision);
    expect(await inAppTemplates(user.id)).toHaveLength(1);
    expect(await queuedEmails(user.id)).toEqual([]);

    await setPreference(cookie, { category: 'decisions', inApp: false, email: true });
    await notify(pool, user.id, decision);
    expect(await inAppTemplates(user.id)).toHaveLength(1);
    expect(await queuedEmails(user.id)).toHaveLength(1);
  });

  it('หมวดความปลอดภัยปิดไม่ได้: ตั้งค่าไม่ได้ (400) และแจ้งทั้งสองช่องทางเสมอ แม้ปิดหมวดอื่นหมด', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    expect((await setPreference(cookie, { category: 'security', inApp: false, email: false })).status).toBe(400);
    await setPreference(cookie, { category: 'decisions', inApp: false, email: false });
    await setPreference(cookie, { category: 'expiry', inApp: false, email: false });
    expect(await notify(pool, user.id, security)).toEqual({ inApp: true, email: true });
  });

  it('สรุปงานผู้อนุมัติ: อีเมลอย่างเดียว (ไม่มีในระบบ) และปิดอีเมลได้', async () => {
    await createUser({ accountType: 'external', approvalStatus: 'pending' });
    await createTestRole('test_user_approver', ['user:approve']);
    const approver = await createUser({ roles: ['user', 'staff', 'test_user_approver'] });
    const other = await createUser({ roles: ['user', 'staff', 'test_user_approver'] });
    expect((await setPreference(await loginAs(other.id), { category: 'approver_digest', inApp: true, email: false })).status).toBe(
      200,
    );

    expect(await queueApproverDigest(new Date('2026-11-02T02:00:00Z'))).toBe(1);
    expect((await queuedEmails(approver.id)).map((e) => e.template)).toEqual(['approver_digest']);
    expect(await inAppTemplates(approver.id)).toEqual([]);
    expect(await queuedEmails(other.id)).toEqual([]);
  });
});

describe('GET/PUT /me/notification-preferences', () => {
  it('ยังไม่ login → 401 / ไม่ส่ง Origin → 403 (CSRF)', async () => {
    await request(app).get('/me/notification-preferences').expect(401);
    const user = await createUser();
    await request(app)
      .put('/me/notification-preferences')
      .set('Cookie', await loginAs(user.id))
      .send({ category: 'expiry', inApp: true, email: false })
      .expect(403);
  });

  it('ผู้ใช้ทั่วไปเห็น 2 หมวด (ค่าเริ่มต้นเปิด) / ผู้อนุมัติเห็นสรุปงานด้วย / ตั้งสรุปงานโดยไม่ใช่ผู้อนุมัติ → 422', async () => {
    const user = await createUser();
    const cookie = await loginAs(user.id);
    const res = await request(app).get('/me/notification-preferences').set('Cookie', cookie).expect(200);
    expect(res.body.preferences).toEqual([
      { category: 'decisions', inApp: true, email: true, emailOnly: false },
      { category: 'expiry', inApp: true, email: true, emailOnly: false },
    ]);
    const denied = await setPreference(cookie, { category: 'approver_digest', inApp: false, email: false });
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe('CATEGORY_NOT_AVAILABLE');

    const updated = await setPreference(cookie, { category: 'expiry', inApp: false, email: true });
    expect(updated.body.preferences[1]).toEqual({ category: 'expiry', inApp: false, email: true, emailOnly: false });

    const admin = await createUser({ roles: ['user', 'staff', 'super_admin'] });
    const adminPrefs = await request(app).get('/me/notification-preferences').set('Cookie', await loginAs(admin.id));
    expect(adminPrefs.body.preferences.at(-1)).toEqual({
      category: 'approver_digest',
      inApp: false,
      email: true,
      emailOnly: true,
    });
  });
});

describe('รายการแจ้งเตือนในระบบ', () => {
  it('ยังไม่ login → 401 / เห็นเฉพาะของตัวเอง พร้อมข้อความไทยและลิงก์', async () => {
    await request(app).get('/me/notifications').expect(401);
    const user = await createUser();
    const other = await createUser();
    await notify(pool, user.id, decision);
    await notify(pool, other.id, security);

    const res = await request(app).get('/me/notifications').set('Cookie', await loginAs(user.id)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ unreadCount: 1, nextCursor: null });
    expect(res.body.notifications).toEqual([
      {
        id: expect.any(String),
        title: 'คำขอใบรับรองประจำตัวไม่ได้รับอนุมัติ',
        body: 'เหตุผล: ยังไม่ผ่านการตรวจสอบ',
        href: '/certificates',
        readAt: null,
        createdAt: expect.any(String),
      },
    ]);
  });

  it('แบ่งหน้าละ 20 ใหม่ก่อน ด้วย cursor', async () => {
    const user = await createUser();
    for (let i = 0; i < 25; i++) await notify(pool, user.id, decision);
    const cookie = await loginAs(user.id);
    const first = await request(app).get('/me/notifications').set('Cookie', cookie);
    expect(first.body.notifications).toHaveLength(20);
    expect(first.body.unreadCount).toBe(25);
    const second = await request(app).get(`/me/notifications?before=${first.body.nextCursor}`).set('Cookie', cookie);
    expect(second.body.notifications).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.notifications, ...second.body.notifications].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(25);
    expect([...ids].sort().reverse()).toEqual(ids);
    expect((await request(app).get('/me/notifications?before=x').set('Cookie', cookie)).status).toBe(400);
  });

  it('อ่านแล้วทีละรายการ (ของคนอื่น → 404) / อ่านทั้งหมด / นับที่ยังไม่อ่าน', async () => {
    const user = await createUser();
    const other = await createUser();
    await notify(pool, user.id, decision);
    await notify(pool, user.id, security);
    await notify(pool, other.id, decision);
    const cookie = await loginAs(user.id);
    const count = async () =>
      (await request(app).get('/me/notifications/unread-count').set('Cookie', cookie)).body.unreadCount;
    expect(await count()).toBe(2);

    const mine = (await request(app).get('/me/notifications').set('Cookie', cookie)).body.notifications;
    const post = (path: string) => request(app).post(path).set('Cookie', cookie).set('Origin', ORIGIN);
    await post(`/me/notifications/${mine[0].id}/read`).expect(204);
    expect(await count()).toBe(1);

    const othersId = (await pool.query(`SELECT id FROM notifications WHERE user_id = $1`, [other.id])).rows[0].id;
    expect((await post(`/me/notifications/${othersId}/read`)).status).toBe(404);
    expect((await post('/me/notifications/not-a-uuid/read')).status).toBe(400);

    await post('/me/notifications/read-all').expect(204);
    expect(await count()).toBe(0);
    const otherUnread = await pool.query(`SELECT read_at FROM notifications WHERE user_id = $1`, [other.id]);
    expect(otherUnread.rows[0].read_at).toBeNull();
  });

  it('ลบที่เกิน 90 วัน (PDPA)', async () => {
    const user = await createUser();
    await notify(pool, user.id, decision);
    await notify(pool, user.id, security);
    await pool.query(
      `UPDATE notifications SET created_at = now() - interval '91 days' WHERE template = 'primary_request_rejected'`,
    );
    expect(await purgeOldNotifications()).toBe(1);
    expect(await inAppTemplates(user.id)).toEqual(['certificate_downloaded']);
  });
});
