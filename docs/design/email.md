# อีเมลแจ้งเตือน

> สถานะ: ระยะที่ 1 (เหตุการณ์ ก–จ) สร้างแล้ว 2026-11-03 — ระยะที่ 2 (ใบใกล้หมดอายุ, สรุปคิวให้ผู้อนุมัติ) ยังไม่ได้สร้าง
> ตัดสินใจ 2026-11-03: ส่งด้วย Gmail API ของบัญชีระบบ @msu.ac.th, ชื่อผู้ส่ง "MSU Digital ID", เก็บในคิว 30 วัน, เพิ่มในประกาศความเป็นส่วนตัว (ฉบับที่ 2)

## หลักการ

- **ส่งจากคิว ไม่ส่งระหว่างทำงาน:** service เขียน `email_outbox` ใน transaction เดียวกับงาน (`enqueueEmail(client, userId, notice)`) งาน rollback = ไม่มีอีเมล, Gmail ล่ม = งานยังสำเร็จ แล้ว job ส่งให้ภายหลัง
- **ผู้รับ = ผู้ใช้ในระบบเท่านั้น** คิวเก็บ `recipient_user_id` อีเมล/ชื่ออ่านจาก `users` ตอนส่ง (ได้อีเมลล่าสุด, ไม่คัดลอกข้อมูลส่วนบุคคลเก็บซ้ำ) ผู้ใช้ถูกลบบัญชี = ไม่ส่ง
- **เนื้อหาไม่อ่อนไหว:** ข้อความล้วน (ไม่มี HTML) ไม่มีลิงก์ดาวน์โหลด/token — ลิงก์กลับหน้าระบบให้ login เอง อีเมลที่ถูกปลอมหรือส่งต่อจึงพาไปเอา key ไม่ได้
- **ไม่ log ผู้รับหรือเนื้อหา** (production) — log มีแค่ `emailId` + ชื่อแม่แบบ

## เหตุการณ์ที่แจ้ง (ระยะที่ 1)

| แม่แบบ | เมื่อ | ที่ |
|---|---|---|
| `account_approved` / `account_rejected` | ผู้ดูแลอนุมัติ/ปฏิเสธบัญชีบุคลากรภายนอกหรือบัญชีหน่วยงาน (ไม่แจ้งเมื่อระบบอนุมัติเองตอน ERP พบ — ผู้ใช้กำลัง login อยู่) | `user-admin-service` |
| `primary_request_approved` / `_rejected` | ตัดสินคำขอใบประจำตัว | `primary-certificate-request-service` |
| `supplementary_request_approved` / `_rejected` | ตัดสินคำขอใบเสริม (พร้อมช่วงวันที่อนุมัติ) | `supplementary-certificate-service` |
| `revocation_request_rejected` | ปฏิเสธคำขอเพิกถอน | `certificate-revocation-request-service` |
| `certificate_revoked` (`by`: `self` / `admin` / `request`) | เจ้าของเพิกถอนเอง, ผู้ดูแลเพิกถอน, อนุมัติคำขอเพิกถอน (ฉบับเดียว ไม่แยกแจ้งผลคำขอ) | `certificate-service`, `certificate-revocation-request-service` |
| `certificate_downloaded` | ดาวน์โหลด `.p12` ใหม่จาก key สำรอง (เตือนเจ้าของ — ถ้าไม่ได้ทำเองให้เพิกถอน) | `certificate-service` |

ไม่แจ้ง: ใบถูกเพิกถอนเพราะปิด/ลบ/หมดอายุบัญชี (บัญชีใช้งานไม่ได้แล้ว), การออกใบตามปกติ (ผู้ใช้กดเองและเห็นผลทันที)

ระยะที่ 2 (ต้องมี job ตามรอบ): ใบใกล้หมดอายุ (เช่น 30 และ 7 วัน), แจ้งผู้อนุมัติเมื่อมีคำขอรอ (ทุกครั้งหรือสรุปรายวัน — ยังไม่ตัดสิน)

## การส่ง

- `src/mail/transport.ts` — `mailTransport.send()` จุดเดียวที่ส่งออก (test mock object นี้)
  - `MAIL_TRANSPORT=log` (ค่าเริ่มต้น, test บังคับเสมอ): เขียน log แทน — dev เห็นผู้รับ/เนื้อหา, production เห็นแค่หัวเรื่อง
  - `MAIL_TRANSPORT=gmail`: `POST gmail/v1/users/me/messages/send` ด้วย access token จาก refresh token (`google-auth-library` — ไม่มี dependency ใหม่) scope `gmail.send` อย่างเดียว (ส่งได้ อ่านกล่องจดหมายไม่ได้)
- `src/mail/mime.ts` — MIME ข้อความล้วน UTF-8 base64, หัวเรื่อง/ชื่อเป็น encoded-word (RFC 2047), ตรวจอีเมลผู้รับกัน header injection, `Auto-Submitted: auto-generated`
- `src/mail/outbox.ts` — job `startEmailJob` ใน API (`server.ts`) ทุก `MAIL_POLL_INTERVAL_MS` (30 วินาที) รอบละไม่เกิน 20 ฉบับ
  - ดึงด้วย `FOR UPDATE OF o SKIP LOCKED` ทีละฉบับ (API หลายตัวไม่ส่งซ้ำ)
  - ไม่สำเร็จ: ลองใหม่หลัง 1, 5, 30, 120, 360 นาที (รวม ~9 ชั่วโมง) ครบแล้ว = `failed`; error ถาวร (HTTP 400 / ผู้รับผิดรูปแบบ) = `failed` ทันที
  - ส่งสำเร็จแต่ commit ไม่ทัน (เช่น DB ล่มพอดี) อาจส่งซ้ำ 1 ครั้ง — ยอมรับได้
- โควตา Gmail ของ Workspace ประมาณ 2,000 ฉบับ/วัน/บัญชี — ระยะที่ 1 ไม่ใกล้เคียง (ระยะที่ 2 ต้องคำนวณ)

## ตั้งค่าบัญชีผู้ส่ง (ครั้งเดียว)

1. Google Cloud Console (project เดียวกับ login): เปิด **Gmail API**
2. OAuth consent screen เป็น **Internal** (External + Testing = refresh token หมดอายุใน 7 วัน)
3. Credentials → Create OAuth client ID → **Desktop app** (แยกจาก client ของ login — ไม่ต้องลงทะเบียน redirect URI)
4. บนเครื่องที่เปิด browser ได้ ใส่ `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `MAIL_FROM_ADDRESS` ใน `apps/api/.env` แล้วรัน `pnpm --filter api mail:authorize` → เปิด URL → login ด้วยบัญชีผู้ส่ง → สคริปต์ตรวจว่าเป็นบัญชีเดียวกับ `MAIL_FROM_ADDRESS` แล้วแสดง refresh token
5. production: ใส่ค่าใน `env/api.env` (`MAIL_TRANSPORT=gmail` + `MAIL_FROM_*` + `GMAIL_*`) แล้ว restart api → ทดสอบ `docker compose run --rm api node dist/scripts/mail-test.js --to <อีเมลของคุณ>`
6. ลบค่า `GMAIL_*` ออกจาก `apps/api/.env` ของเครื่องที่ใช้ขอ token (ถ้าไม่ได้ใช้ทดสอบต่อ)

refresh token ถูกยกเลิกเมื่อ: เปลี่ยนรหัสผ่านของบัญชีผู้ส่ง, ถอนสิทธิ์แอปที่ myaccount.google.com/permissions, หรือผู้ดูแล Workspace ปิดแอป — อาการ: log `ขอ access token ของ Gmail ไม่สำเร็จ: invalid_grant` ให้ทำข้อ 4–5 ใหม่ (อีเมลที่ค้างในคิวส่งต่อเองถ้าแก้ภายในรอบลองใหม่ ~9 ชั่วโมง)

## PDPA

- คิว `email_outbox`: ผู้รับ (user id), ชื่อแม่แบบ, params (serial, ช่วงวันที่, เหตุผล/บันทึกของผู้พิจารณา), สถานะ — ลบทุกสถานะเมื่อเกิน 30 วัน (`EMAIL_RETENTION_DAYS`, job รายชั่วโมง) และลบทันทีเมื่อลบบัญชี (`deletedEmails` ใน audit)
- **สำเนาในกล่อง "ส่งแล้ว" ของบัญชีผู้ส่ง:** Gmail API เก็บทุกฉบับที่ส่ง และ scope `gmail.send` ลบไม่ได้ — ประกาศระบุ 30 วัน จึงต้องตั้งกฎเก็บรักษา (retention rule ใน Google Vault / Admin console ของ Workspace) ให้บัญชีนี้ลบอีเมลที่ส่งแล้วเกิน 30 วัน **ก่อนเปิด `MAIL_TRANSPORT=gmail`**
- ผู้รับข้อมูลเพิ่ม: Google (Gmail ของบัญชีมหาวิทยาลัย) — ระบุในประกาศฉบับที่ 2 หัวข้อ 4
