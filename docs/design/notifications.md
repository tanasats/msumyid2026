# การแจ้งเตือนในระบบและการตั้งค่า

> สถานะ: สร้างแล้ว 2026-11-03 (PR แรก: กระดิ่ง หน้า `/notifications` และการตั้งค่า) — ยังไม่ได้สร้าง: ตัวเลขงานค้างบนเมนู "จัดการระบบ" / "อนุมัติ" (PR ที่สอง)
> ตัดสินใจ 2026-11-03: 4 หมวด, หมวดความปลอดภัยบังคับ, สรุปงานผู้อนุมัติเป็นอีเมลอย่างเดียว, เก็บ 90 วัน, ประกาศความเป็นส่วนตัวฉบับที่ 3, ทำตามที่ผู้ใช้เลือก (ไม่ส่งอีเมลแทนเมื่อผู้ใช้ไม่เข้าระบบ)
> ช่องทางอีเมล (คิว, Gmail, เพดาน): `docs/design/email.md`

## หลักการ

- **จุดเดียว:** ทุกเหตุการณ์เรียก `notify(client, userId, notice)` (`services/user-notification-service.ts`) ใน transaction ของงาน — อ่านการตั้งค่าของผู้รับ แล้วสร้างแถว `notifications` และ/หรือเข้าคิว `email_outbox`
- **แม่แบบชุดเดียว:** `mail/templates.ts` — `renderEmail` (อีเมล) และ `renderInAppNotification` (หัวข้อ + รายละเอียดสั้น + ลิงก์ในระบบ) ตารางเก็บแม่แบบ + params ข้อความไทยสร้างตอนแสดง
- **การตั้งค่าเป็นของผู้ใช้เอง:** ไม่มีแถวใน `notification_preferences` = เปิดทั้งสองช่องทาง

## หมวด

| หมวด | แม่แบบ | ในระบบ | อีเมล | ตั้งค่าได้ |
|---|---|---|---|---|
| `account` ผลการอนุมัติบัญชี | `account_approved/rejected` | ✓ | ✓ | ไม่ได้ — ผู้ใช้ยังเข้าระบบมาตั้งค่าไม่ได้ |
| `decisions` ผลการพิจารณาคำขอ | `primary_/supplementary_request_*`, `revocation_request_rejected` | ✓ | ✓ | ได้ |
| `security` ความปลอดภัยของใบรับรอง | `certificate_revoked`, `certificate_downloaded` | ✓ | ✓ | **ไม่ได้** — ผู้ที่แอบเข้าบัญชีต้องปิดการเตือนนี้ไม่ได้ |
| `expiry` ใบใกล้หมดอายุ | `certificate_expiring` | ✓ | ✓ | ได้ |
| `approver_digest` สรุปงานรอพิจารณา | `approver_digest` | — | ✓ | ได้ (เฉพาะผู้มี `user:approve` / `certificate:approve` / `certificate:revoke`) |

อีเมลของหมวดที่ตั้งค่าได้มีบรรทัด "เปิด/ปิดการแจ้งเตือนประเภทนี้ได้ที่ …/account#notifications" ท้ายอีเมล

## API (ต้อง login เท่านั้น — ของตัวเองเท่านั้น)

| | |
|---|---|
| `GET /me/notifications?before=<id>` | หน้าละ 20 ใหม่ก่อน (cursor = id uuidv7) + `unreadCount` + `nextCursor` |
| `GET /me/notifications/unread-count` | กระดิ่ง — นับจาก partial index `notifications_unread_idx` |
| `POST /me/notifications/:id/read` | ของคนอื่น = 404 |
| `POST /me/notifications/read-all` | |
| `GET /me/notification-preferences` | หมวดที่ผู้ใช้ตั้งได้ พร้อมค่า (`emailOnly` = ไม่มีช่องในระบบ) |
| `PUT /me/notification-preferences` | `{ category, inApp, email }` — หมวดที่ไม่มีสิทธิ์ = 422 `CATEGORY_NOT_AVAILABLE`, หมวดบังคับ = 400 |

## หน้าเว็บ

- กระดิ่งบน header (ผู้ใช้ที่อนุมัติแล้ว) — ตัวเลขยังไม่อ่าน อัปเดตเมื่อเปลี่ยนหน้า ทุก 60 วินาที และเมื่อกลับมาที่แท็บ (ไม่ใช้ WebSocket: ไม่ต้องเพิ่ม dependency/ตั้ง nginx)
- `/notifications` — กดรายการ = อ่านแล้ว + ไปหน้าที่เกี่ยวข้อง, ปุ่ม "อ่านทั้งหมด", ดูรายการก่อนหน้า
- `/account#notifications` — ตารางหมวด × ช่องทาง (สวิตช์ บันทึกทันที) + แถวความปลอดภัยแบบล็อก

## PDPA

- `notifications` ลบเมื่อเกิน 90 วัน (`NOTIFICATION_RETENTION_DAYS`, job ใน `notification-service.ts` ทุก 15 นาที) และลบทันทีเมื่อลบบัญชี (`deletedNotifications` ใน audit) พร้อม `notification_preferences`
- ประกาศความเป็นส่วนตัวฉบับที่ 3: ข้อมูลการแจ้งเตือน/การตั้งค่า, ระยะเก็บ 90 วัน, สิทธิเปิด/ปิดเอง
