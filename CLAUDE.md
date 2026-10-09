# CLAUDE.md

ไฟล์นี้ให้บริบทและกฎการทำงานแก่ Claude Code ในโปรเจกต์นี้ อ่านให้ครบก่อนเริ่มงานทุกครั้ง

## 1. ภาพรวมโปรเจกต์
- **ชื่อระบบ:** MSU Digital ID (ระบบบริหารจัดการใบรับรองดิจิทัล มหาวิทยาลัยมหาสารคาม)
- **วัตถุประสงค์:** เป็นระบบยกระดับการบริหารจัดการใบรับรองดิจิทัลสู่ระบบบริการอัตโนมัติแบบครบวงจรที่มีความมั่นคงปลอดภัยสูง 

- **ผู้ใช้หลัก:**  นิสิต,บุคลากร,บุคลากรภายนอก,ผู้ดูแลระบบ และผู้ดูแลระบบสูงสุด
- **ภาษาของ UI:** ไทย (ข้อความทั้งหมดในหน้าจอเป็นภาษาไทย)
- **การเข้าสู่ระบบ:** Google Account (Gmail) และมีระบบรหัสผ่านของตัวเอง

## 2. Tech Stack
| ส่วน | เทคโนโลยี |
|---|---|
| Frontend | Next.js (App Router) + Tailwind CSS |
| Backend (API) | Node.js + Express 5 (แยกเป็นบริการของตัวเอง) |
| บริการเซ็น (Signer) | Node.js + Express 5 + OpenSSL CLI — ถือ key ของ Intermediate CA และ KEK ของ key สำรอง ให้ API เรียกเท่านั้น |
| Database | PostgreSQL |
| DB Driver | `pg` (node-postgres) เขียน SQL ตรง ๆ **ไม่ใช้ ORM** |
| Migration | `node-pg-migrate` |
| File Storage | Garage (S3-compatible) |
| S3 Client | `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` |
| Auth | Google OAuth 2.0 / OpenID Connect + Session ใน PostgreSQL (`google-auth-library`) |
| ภาษา | TypeScript ทั้ง frontend และ backend |
| Package manager | pnpm (workspaces) |

## 3. สภาพแวดล้อมพัฒนา (Dev)
Web, API และ Signer รันบนเครื่อง dev โดยตรง ส่วน Postgres และ Garage รันด้วย Docker

| บริการ | รันที่ | URL / Port |
|---|---|---|
| Web (Next.js) | เครื่อง dev | http://localhost:3010 |
| API (Express) | เครื่อง dev | http://localhost:4010 |
| Signer (Express) | เครื่อง dev | http://localhost:4020 (API เรียกเท่านั้น ห้ามเปิดสู่ภายนอก) |
| PostgreSQL | Docker | localhost:5442 |
| Garage S3 API | Docker | http://localhost:3910 |
| Garage Admin API | Docker | http://localhost:3913 (ใช้จัดการ bucket/key ไม่มี console ในตัว) |

> port ข้างบนเลี่ยงค่ามาตรฐาน (3000/4000/5432/3900/3903) เพราะเครื่อง dev รันระบบอื่นขององค์กรพร้อมกัน
> ชื่อเฉพาะของระบบนี้: compose project `msumyid`, volume `msumyid_*`, cookie `msumyid_session`

หลักการสำคัญ:
- **port ทั้งหมดต้องอ่านจาก env** ห้ามฮาร์ดโค้ด เพราะ port ชนกับโปรแกรมอื่นบนเครื่องได้ง่าย
- Docker ต้อง pin เวอร์ชัน image (ห้ามใช้ `latest`) และใช้ named volume เพื่อไม่ให้ข้อมูลหาย
- ฐานข้อมูลใน container เดียวกันมี 2 ฐาน: `app_dev` และ `app_test` ห้ามรัน test กับ `app_dev`
- หลายระบบบนเครื่องเดียวกัน: ตั้ง `name:` ของ docker compose และชื่อ volume ให้ไม่ซ้ำกันต่อระบบ และเปลี่ยน port ผ่าน env เมื่อต้องรันพร้อมกัน
- ไฟล์ env: `apps/api/.env` และ `apps/web/.env.local` (ห้าม commit) พร้อม `.env.example` ที่ต้องอัปเดตทุกครั้งที่เพิ่มตัวแปร

ตัวแปร env หลัก:
```
# apps/api/.env
PORT=4010
TRUST_PROXY=                              # production หลัง nginx = 1 (ห้าม true)
WEB_URL=http://localhost:3010
CORS_ORIGIN=http://localhost:3010
DATABASE_URL=postgres://app:app@localhost:5442/app_dev
TEST_DATABASE_URL=postgres://app:app@localhost:5442/app_test

# Google OAuth (สร้างที่ Google Cloud Console)
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...                 # ค่าจริงอยู่ใน apps/api/.env เท่านั้น
GOOGLE_REDIRECT_URI=http://localhost:4010/auth/google/callback
SESSION_COOKIE_NAME=msumyid_session
SESSION_TTL_DAYS=7
INITIAL_SUPER_ADMIN_EMAIL=tanasat.s@msu.ac.th              # ใช้เฉพาะ seed ครั้งแรก
ALLOWED_EMAIL_DOMAINS=msu.ac.th               # โดเมนที่ไม่ต้องรออนุมัติ (ตรวจทั้ง email และ claim hd) โดเมนอื่น = บุคลากรภายนอก รออนุมัติ

# Storage (Garage)
S3_ENDPOINT=http://localhost:3910
S3_PUBLIC_ENDPOINT=http://localhost:3910
S3_REGION=garage
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
S3_BUCKET=app-files
S3_FORCE_PATH_STYLE=true

# ERP-HR มมส. — ดึงข้อมูลบุคลากรด้วย Google access token ตอน login
ERP_HR_STAFFINFO_URL=https://erp.msu.ac.th/service/api/staffinfo
ERP_HR_TIMEOUT_MS=5000                    # เกินเวลานี้ข้ามไป login ยังผ่าน

# รอบตรวจปิดบัญชีที่ถึงวันหมดอายุ (ms, ไม่ใส่ = 1 ชั่วโมง) — การตัดสิทธิ์มีผลทันทีอยู่แล้ว
ACCOUNT_EXPIRY_CHECK_INTERVAL_MS=3600000

# อีเมลแจ้งเตือน (ยังไม่ได้สร้าง — ทำภายหลัง) — dev/test: log, production: gmail + GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN
MAIL_TRANSPORT=log

# บริการเซ็น (ค่า SIGNER_TOKEN เดียวกับ apps/signer/.env)
SIGNER_URL=http://localhost:4020
SIGNER_TOKEN=...
SIGNER_TIMEOUT_MS=30000
# CRL: ออกใหม่ทันทีเมื่อเพิกถอน + ทุก CRL_REISSUE_HOURS, เผยแพร่ที่ GET /crl/msu-ca.crl (cdp.msu.ac.th ใช้ cron ดึง)
CRL_VALIDITY_DAYS=7
CRL_REISSUE_HOURS=24
CRL_CHECK_INTERVAL_MS=300000
CRL_PUBLISH_FORMAT=pem                    # pem = แบบ openssl ca -gencrl เดิม, der = ตาม RFC 5280

# apps/signer/.env (ดู apps/signer/.env.example)
SIGNER_PORT=4020
SIGNER_TOKEN=...                          # อย่างน้อย 32 ตัว (openssl rand -hex 32)
CA_CERT_PATH=... CA_KEY_PATH=... CA_KEY_PASSPHRASE=...   # dev = CA ปลอมจาก dev-ca ห้ามใช้ CA key จริงบนเครื่อง dev
CA_CHAIN_PATH=...                         # root ที่ออก Intermediate (ใส่ลง .p12) — production = apps/signer/ca/root.cert.pem, dev = root ของ dev-ca
ESCROW_KEK=...                            # base64 32 ไบต์ (openssl rand -base64 32) หายแล้วกู้ key สำรองไม่ได้
ESCROW_KEK_ID=dev-1
CRL_DISTRIBUTION_URL=https://cdp.msu.ac.th/msu-ca.crl

# apps/web/.env.local
API_URL=http://localhost:4010              # ใช้ฝั่ง server (Server Component)
NEXT_PUBLIC_API_URL=http://localhost:4010  # ใช้ฝั่ง browser
```

## 4. โครงสร้างโปรเจกต์
```
/apps
  /web                  # Next.js + Tailwind
    /src/app            # routes (App Router)
    /src/components
    /src/lib            # เรียก API, helper
  /api                  # Node.js + Express
    /src/app.ts         # สร้าง Express app (ไม่ listen) เพื่อให้ test ได้
    /src/server.ts      # เริ่ม listen ที่ PORT
    /src/routes         # endpoint + validation (บาง ไม่มี logic)
    /src/middlewares    # auth, requirePermission, error handler, logger
    /src/services       # business logic (รวม auth และ role)
    /src/repositories   # SQL ทั้งหมดอยู่ที่นี่เท่านั้น
    /src/db             # pool, transaction helper
    /src/storage        # ตัวครอบ (wrapper) การเรียก S3
    /src/mail           # ตัวส่งอีเมล (Gmail API / log), แม่แบบอีเมล, worker ส่งจากคิว email_outbox
    /src/config         # อ่านและตรวจสอบ env ด้วย Zod
    /migrations         # ไฟล์ node-pg-migrate
    /scripts            # seed ผู้ดูแลระบบสูงสุด ฯลฯ
    /tests
  /signer               # บริการเซ็น: ออกใบรับรอง (OpenSSL CLI), key สำรอง (escrow) — ไม่มีฐานข้อมูล
    /src/services       # certificate-issuer, escrow, ca, openssl
    /scripts            # create-dev-ca (CA ปลอมสำหรับ dev/test)
    /tests              # ทดสอบกับ OpenSSL จริงและ CA ปลอม
/docker
  /garage/garage.toml   # config ของ Garage สำหรับ dev
/deploy                 # production: compose, nginx, env ตัวอย่าง, สคริปต์ deploy/backup (ดู docs/deployment.md)
/.github/workflows      # CI (ทุก PR) และ Release (build image ไป GHCR)
/docs
docker-compose.yml      # postgres + garage สำหรับ dev
.env.example
```

## 5. คำสั่งที่ใช้บ่อย
- ติดตั้ง: `pnpm install`
- เปิด Postgres + Garage: `docker compose up -d`
- รัน web: `pnpm --filter web dev`
- รัน api: `pnpm --filter api dev` (ใช้ `tsx watch`)
- รัน signer: `pnpm --filter signer dev` (ต้องมี OpenSSL CLI — บน Windows มากับ Git Bash)
- นำเข้าใบรับรองเดิมจาก openssl ca: `pnpm --filter api cert:import -- --dir <โฟลเดอร์ CA> [--dry-run]` (ต้องเปิด signer — ลำดับการย้ายระบบดู `docs/design/certificates.md`)
- สร้าง CA ปลอมสำหรับ dev: `pnpm --filter signer dev-ca` (รันซ้ำได้ ไม่สร้างทับ — แสดงค่า env ที่ต้องใส่ใน `apps/signer/.env`)
- ทดสอบ: `pnpm test`
- Lint / Type check: `pnpm lint` / `pnpm typecheck`
- สร้าง migration: `pnpm --filter api migrate create ชื่อ-migration`
- รัน migration: `pnpm --filter api migrate up`
- ย้อน migration ล่าสุด (dev เท่านั้น): `pnpm --filter api migrate down`
- seed ผู้ดูแลระบบสูงสุด: `pnpm --filter api seed:super-admin` (เจ้าของ `INITIAL_SUPER_ADMIN_EMAIL` ต้อง login ด้วย Google 1 ครั้งก่อน)
- สร้าง key + bucket ของ Garage (dev และ test): `bash docker/garage/setup.sh` (รันซ้ำได้)
- ตั้ง CORS ของ bucket ให้หน้าเว็บอัปโหลดได้: `pnpm --filter api storage:cors` (รันซ้ำได้)
- deploy production (บน VM): `./scripts/deploy.sh sha-<commit>` — ขั้นตอนทั้งหมดดู `docs/deployment.md`

## 6. มาตรฐานการเขียนโค้ด
- ชื่อตัวแปร/ฟังก์ชันเป็นภาษาอังกฤษ camelCase, ชื่อ component เป็น PascalCase
- คอมเมนต์เขียนเป็นภาษาไทย (ชื่อเทคนิคคงเป็นอังกฤษ)
- ห้ามใช้ `any` ถ้าจำเป็นต้องอธิบายเหตุผลในคอมเมนต์
- ห้ามฮาร์ดโค้ดค่า config ให้อ่านผ่าน `src/config` ซึ่งตรวจสอบ env ตอนเริ่มระบบและหยุดทำงานทันทีถ้าขาด
- จัดการ error ทุกครั้ง ห้ามกลืน error เงียบ ๆ

## 7. Backend (Express 5)
- Route ทำแค่: รับ request, validate ด้วย Zod, เรียก service, ส่ง response ห้ามมี SQL หรือ business logic
- error ทุกตัวไปจบที่ error middleware ตัวเดียว รูปแบบ `{ "error": { "code": "...", "message": "..." } }` ห้ามส่ง stack trace หรือรายละเอียด SQL ออกไป
- Middleware ที่ต้องมี: `helmet`, `cors`, `cookie-parser`, JSON body limit, request logger (`pino`), error handler
- **CORS:** `origin` ต้องเป็นค่าจาก `CORS_ORIGIN` เท่านั้น (ห้าม `*`) และเปิด `credentials: true`
- ใส่ rate limit (`express-rate-limit`) ที่ขั้นตอนเข้าสู่ระบบ (`/auth/google`, `/auth/google/callback` และ login ด้วยรหัสผ่านในอนาคต) — **ห้าม**จำกัด `/auth/me` เพราะ Next.js เรียกจาก server ทุกหน้า (IP เดียวกันทุกผู้ใช้) จะทำให้ทั้งระบบถูกบล็อก
- ต้องมี `GET /health` ที่ตรวจการเชื่อมต่อ database
- Graceful shutdown: ปิด HTTP server แล้วค่อย `pool.end()`

## 8. การยืนยันตัวตน (Google Login)
**API เป็นเจ้าของกระบวนการ login ทั้งหมด** (ไม่ใช้ Auth.js ฝั่ง Next.js) เพราะผู้ใช้และสิทธิ์อยู่ใน PostgreSQL ที่ API ดูแล

Flow (Authorization Code + PKCE):
1. หน้า web มีปุ่มลิงก์ไป `GET {API}/auth/google`
2. API สร้าง `state`, `nonce`, PKCE verifier เก็บใน cookie อายุสั้น (httpOnly) แล้ว redirect ไป Google (scope: `openid email profile`)
3. Google เรียกกลับ `GET /auth/google/callback` → API ตรวจ `state`, แลก code, **ตรวจ ID token** (signature, `aud`, `iss`, `exp`, `nonce`) ด้วย `google-auth-library`
4. ต้องได้ `email_verified = true` ไม่เช่นนั้นปฏิเสธ
5. ค้นหาผู้ใช้ด้วย **`google_sub`** (ไม่ใช้ email เป็นตัวระบุ เพราะ email เปลี่ยนได้) ถ้าไม่พบ: ผูกกับบัญชีที่ผู้ดูแลลงทะเบียนล่วงหน้าด้วยอีเมลนั้นก่อน (`google_sub` ยังเป็น NULL, อีเมลโดเมน มมส. ต้องมี `hd` ตรง) ถ้าไม่มีจึงสร้างใหม่พร้อมกำหนด role `user` (ทำใน transaction เดียว)
5.1 แยกประเภทบัญชีจากส่วนหน้า @: ตัวเลข 11 หลักพอดี = นิสิต (ให้ role `student`, คณะ = หลักที่ 5-6 อ้างอิง `org_units.code`, ไม่พบ = NULL) นอกนั้น = บุคลากร (ให้ role `staff` และดึงข้อมูลจาก ERP-HR ด้วย Google access token) ตรวจและให้ role ทุกครั้งที่ login พร้อม log
5.2 บัญชีใหม่ที่ ERP ตอบว่า **ไม่พบบุคลากร** = บัญชีหน่วยงาน (`service`) สถานะรออนุมัติ (ERP เรียกไม่สำเร็จ = ยังเป็นบุคลากร, บัญชีเดิมไม่เปลี่ยนประเภทอัตโนมัติ)
5.3 ใบรับรองที่นำเข้าจากระบบเดิมแต่ยังไม่มีเจ้าของ (`certificates.user_id` NULL) ผูกกับผู้ใช้ที่ login ด้วยอีเมลเดียวกัน (เงื่อนไขเดียวกับข้อ 5)
6. สร้าง session แล้ว redirect กลับ `WEB_URL`
7. web ถามผู้ใช้ปัจจุบันจาก `GET /auth/me`, ออกจากระบบด้วย `POST /auth/logout`

กฎ session:
- ใช้ session แบบ **opaque token ที่เก็บใน PostgreSQL** ไม่ใช้ JWT (เพื่อให้เพิกถอนและเปลี่ยนสิทธิ์มีผลทันที)
- token สร้างด้วย `crypto.randomBytes(32)` ใน DB เก็บเฉพาะ **hash (SHA-256)** ห้ามเก็บ token ดิบ
- cookie: `httpOnly`, `SameSite=Lax`, `Secure` (production), ชื่อเฉพาะโปรเจกต์
- ทุก request อ่านผู้ใช้และ role จากฐานข้อมูลใหม่ (ผ่าน session) ห้ามเชื่อ role ที่มากับ client
- ผู้ใช้ที่ `is_active = false` ต้องเข้าระบบไม่ได้ทันที
- **CSRF:** ใช้เฉพาะ POST/PUT/PATCH/DELETE กับการเปลี่ยนข้อมูล และตรวจ header `Origin` ต้องตรงกับ `WEB_URL`
- ตรวจโดเมนของ email (และ claim `hd`) ที่ callback: อยู่ใน `ALLOWED_EMAIL_DOMAINS` = นิสิต/บุคลากร ใช้งานได้ทันที, โดเมนอื่น = บุคลากรภายนอก สร้างบัญชีสถานะรออนุมัติ (ดูหัวข้อ 9)
- บน localhost `:3010` กับ `:4010` ถือเป็น site เดียวกัน cookie จึงส่งได้ แต่ fetch จาก browser ต้องใส่ `credentials: 'include'` ส่วนบน production ให้ web และ API อยู่ใต้โดเมนหลักเดียวกัน

## 9. ระบบสิทธิ์ (Authorization)
แม่แบบนี้ใช้กับหลายระบบ จึง **กำหนดโครงสร้างกลางไว้ แต่ไม่ตายตัวว่ามี role อะไรบ้าง** แต่ละระบบเพิ่ม role และ permission ของตัวเองในตารางด้านล่าง

Role ตั้งต้น (ทุกระบบมี, `is_system = true`, ห้ามลบหรือเปลี่ยน code):

| code | ชื่อไทย | หมายเหตุ |
|---|---|---|
| `user` | ผู้ใช้งานทั่วไป | ทุกคนได้รับตอน login ครั้งแรก และถอนไม่ได้ |
| `super_admin` | ผู้ดูแลระบบสูงสุด | ผ่านทุก permission |

Role และ permission เฉพาะระบบนี้ (**เริ่มต้นเว้นว่างได้** เติมเมื่อมีฟังก์ชันและองค์กรกำหนด role แล้ว ห้าม Claude เดาเอง):

| role code | ชื่อไทย | is_privileged | permissions |
|---|---|---|---|
| `student` | นิสิต | false | (ยังไม่ผูก) — `is_system`, ระบบให้อัตโนมัติตอน login (ส่วนหน้า @ เป็นตัวเลข 11 หลัก) |
| `staff` | บุคลากร | false | (ยังไม่ผูก) — `is_system`, ระบบให้อัตโนมัติตอน login (บัญชี @msu.ac.th อื่น ๆ) |
| `external` | บุคลากรภายนอก | false | (ยังไม่ผูก) — `is_system`, ระบบให้เมื่อบัญชีภายนอกได้รับอนุมัติ |
| `service` | บัญชีหน่วยงาน | false | (ยังไม่ผูก) — `is_system`, ระบบให้เมื่อบัญชีหน่วยงานได้รับอนุมัติ (บัญชีที่ออกให้ระบบสารสนเทศ คณะ/หน่วยงาน หรือกิจกรรม ขอใบรับรองได้เหมือนบุคคล) |
| `admin` | ผู้ดูแลระบบ | true | (ยังไม่ผูก) — ให้/ถอนได้เฉพาะ `super_admin` |

Permission ที่ลงทะเบียนแล้ว (ยังไม่ผูกกับ role ใด → ใช้ได้เฉพาะ `super_admin`):

| permission | คำอธิบาย |
|---|---|
| `user_role:assign` | ให้/ถอน role ที่ไม่ใช่ role สิทธิ์สูงแก่ผู้ใช้อื่น |
| `user:approve` | อนุมัติ/ปฏิเสธบัญชีบุคลากรภายนอกและบัญชีหน่วยงานที่รออนุมัติ |
| `user:read` | ดูรายชื่อ ค้นหา และดูรายละเอียดผู้ใช้ |
| `user:create` | ลงทะเบียนผู้ใช้ล่วงหน้าด้วยอีเมล |
| `user:update` | แก้ไขข้อมูลผู้ใช้ |
| `user:deactivate` | ปิด/เปิดบัญชีผู้ใช้ |
| `user:delete` | ลบบัญชีและข้อมูลส่วนบุคคลของผู้ใช้ |
| `certificate:request` | ขอ ดาวน์โหลด และเพิกถอนใบรับรองของตัวเอง |
| `certificate:read` | ดูใบรับรองของผู้อื่น |
| `certificate:revoke` | เพิกถอนใบรับรองของผู้อื่น |
| `document:sign` | ลงนามเอกสารด้วยใบรับรองของตัวเอง |

ระบบจัดการบัญชีผู้ใช้ (หน้า `/admin/users`, กฎ `canManageUser`, `user_audit_logs`, ระยะการพัฒนา): ดู `docs/design/user-management.md`
ระบบใบรับรอง (บริการเซ็น `apps/signer`, key สำรอง, CRL, นำเข้าใบเดิม, ระยะการพัฒนา): ดู `docs/design/certificates.md` — ลงนามเอกสารบนเว็บ: `docs/design/document-signing.md`

บัญชีบุคลากรภายนอก (ตัดสินใจ 2026-10-07):
- เข้าระบบได้ 2 ทาง: Google (Gmail ทุกโดเมน) หรือรหัสผ่านของระบบ (สำหรับผู้ไม่มีบัญชี Google) — นิสิต/บุคลากร มมส. ใช้ Google เท่านั้น
- บัญชีใหม่มี `users.approval_status = 'pending'` ใช้งานไม่ได้จนผู้มี `user:approve` อนุมัติ จึงได้ role `external`
- `ALLOWED_EMAIL_DOMAINS` จึงหมายถึงโดเมนที่ **ไม่ต้องรออนุมัติ** (ไม่ใช่โดเมนเดียวที่ login ได้)

บัญชีหน่วยงาน (ตัดสินใจ 2026-10-08):
- ประเภทเดียว (`account_type = 'service'`) ครอบคลุมบัญชีระบบสารสนเทศ คณะ/หน่วยงาน และกิจกรรม — ขอใบรับรองได้ไม่ต่างจากบุคคล
- ต้องกำหนด **หน่วยงาน** และ **ผู้รับผิดชอบ** (`responsible_user_id` = บุคลากรที่ใช้งานได้) ก่อนอนุมัติ จึงได้ role `service`
- กำหนด **วันหมดอายุ** ได้ (`account_expires_at`, ไม่บังคับ) ถึงเวลาแล้วตัดสิทธิ์ทันที และ job ปิดบัญชีพร้อมเขียน `user_audit_logs` (action `expire`)

หลักการ:
- **1 ผู้ใช้มีได้หลาย role** ผ่านตาราง `user_roles` สิทธิ์จริงของผู้ใช้ = รวม (union) permission จากทุก role ที่ถืออยู่
- permission ตั้งชื่อรูปแบบ `resource:action` (เช่น `document:approve`) ประกาศเป็นค่าคงที่ในโค้ดที่เดียว และลงทะเบียนในฐานข้อมูลผ่าน migration
- โค้ดตรวจสิทธิ์ด้วย `hasPermission(user, 'x')` และ middleware `requirePermission('x')` เท่านั้น **ห้ามเช็คชื่อ role ตรง ๆ** (เช่น `role === 'staff'`) เพื่อให้เพิ่ม role ใหม่ได้โดยไม่แก้โค้ดทั่วระบบ
- `super_admin` ผ่านทุก permission โดยจัดการใน `hasPermission` ที่เดียว ห้ามเขียนข้อยกเว้นสำหรับ super_admin กระจายในโค้ดส่วนอื่น
- ตรวจสิทธิ์ที่ **API เสมอ** ฝั่ง Next.js ซ่อนเมนูเพื่อ UX เท่านั้น
- endpoint ใหม่ทุกตัวต้องระบุชัดว่า public / ต้อง login / ต้องมี permission ใด (ค่าเริ่มต้นคือต้อง login)

เมื่อยังไม่ได้กำหนด role/permission (กำหนดทีหลังตามฟังก์ชันที่พัฒนา):
- **นักพัฒนากำหนด permission ตามฟังก์ชัน ส่วนองค์กร/`super_admin` กำหนด role** เมื่อสร้างฟังก์ชันที่ต้องควบคุมสิทธิ์ ให้เสนอชื่อ permission พร้อมคำอธิบายสั้น ๆ รอผู้ใช้ยืนยัน แล้วเพิ่มใน migration และในตารางด้านบน
- **ห้ามผูก permission เข้ากับ role ใดเอง** ให้ผู้ใช้หรือ `super_admin` ตัดสินใจ
- **ค่าเริ่มต้นคือปฏิเสธ:** ฟังก์ชันที่ต้องมี permission จะเข้าได้เฉพาะ `super_admin` จนกว่าจะมีการผูก permission กับ role
- ฟังก์ชันที่ทุกคนที่ login แล้วใช้ได้ ไม่ต้องมี permission แต่ต้องระบุชัดเจนในโค้ดว่า "ต้อง login เท่านั้น"

กฎการให้/ถอน role (ทำใน service ที่เดียว เช่น `canGrantRole(actor, role)`):
- role ที่ `is_privileged = true` (รวม `super_admin`) ให้/ถอนได้เฉพาะ `super_admin`
- role อื่นให้/ถอนได้โดยผู้ที่มี permission `user_role:assign`
- ห้ามแก้ role ของตัวเอง, ห้ามถอน role `user`, ห้ามถอน `super_admin` คนสุดท้ายออกจากระบบ
- ทุกการให้/ถอนต้องเขียน `role_change_logs` (ใครทำ, กับใคร, role อะไร, grant หรือ revoke, เหตุผล, เมื่อไร) ใน **transaction เดียวกัน** และห้ามแก้/ลบ log
- `super_admin` คนแรกสร้างผ่าน seed script (`INITIAL_SUPER_ADMIN_EMAIL`) เท่านั้น ห้ามมีช่องทางผ่าน UI หรือ API สาธารณะ
- ตอน login ระบบให้ได้เฉพาะ `user` และ role ประเภทบัญชี (`student` หรือ `staff`) เท่านั้น ห้ามรับ role จาก client — role `external` และ `service` ให้ตอนอนุมัติบัญชีเท่านั้น

ตารางหลัก: `roles` (`code` UNIQUE, `name_th`, `is_system`, `is_privileged`), `permissions` (`code` UNIQUE), `role_permissions`, `users` (`google_sub` UNIQUE, `email`, `name` = ชื่อจาก Google, `display_name` = ชื่อที่ระบบแสดง, `picture_url`, `is_active`, `last_login_at`), `user_roles` (PK `user_id, role_id`, `granted_by`, `granted_at`), `sessions` (`token_hash` UNIQUE, `user_id`, `expires_at`, `last_seen_at`), `role_change_logs`

## 10. กฎการเขียน SQL (สำคัญ)
- **ห้ามใช้ ORM หรือ query builder** ให้เขียน SQL ตรง ๆ ผ่าน `pg`
- **ห้ามต่อสตริง SQL เด็ดขาด** ใช้ parameterized query (`$1, $2, ...`) เท่านั้น
  ```ts
  await pool.query('SELECT id, name FROM users WHERE id = $1', [id]);
  ```
- SQL ทั้งหมดอยู่ใน `repositories/` เท่านั้น ห้ามเขียนใน route หรือ service
- ฟังก์ชัน repository ต้องมีชนิดข้อมูลรับ/คืนค่าชัดเจน ห้าม `SELECT *`
- งานที่แก้หลายตารางพร้อมกันต้องใช้ `withTransaction()` ใน `src/db`
- ใช้ `Pool` ตัวเดียวทั้งแอป ถ้าใช้ `client` จาก pool ต้อง `release()` เสมอ (try/finally)
- query ที่คืนหลายแถวต้องมี `LIMIT` หรือ pagination
- สร้าง index ให้คอลัมน์ที่ใช้ใน WHERE/JOIN บ่อย และตรวจด้วย `EXPLAIN` เมื่อช้า
- ชื่อตารางและคอลัมน์เป็น snake_case ภาษาอังกฤษ ชื่อตารางเป็นพหูพจน์
- ทุกตารางมี `id`, `created_at`, `updated_at` ข้อมูลสำคัญใช้ soft delete (`deleted_at`) และต้องกรอง `deleted_at IS NULL`

## 11. การจัดการไฟล์ (Garage)
- โค้ดผูกกับ **S3 API** ผ่านตัวครอบใน `src/storage` เท่านั้น เพื่อให้เปลี่ยนผู้ให้บริการได้ด้วยการแก้ env
- Garage ใช้ region `garage` และ S3 API ที่ port 3900 ภายใน container (เครื่อง dev map ออกมาเป็น 3910) ต้องตั้ง `forcePathStyle: true`
- Garage ต้องมีไฟล์ `garage.toml` (มี `rpc_secret`) และต้องกำหนด layout ของ cluster ก่อนใช้งาน สำหรับ dev ให้ใช้ Garage v2.3.0 ขึ้นไปที่มี `--single-node` และ pin เวอร์ชัน image
- dev ตั้ง `replication_factor = 1` ส่วน production ต้องออกแบบเรื่อง replication และ backup แยกต่างหาก (Garage ใช้การทำสำเนา ไม่มี erasure coding)
- การสร้าง bucket และ access key ทำผ่านสคริปต์ที่อยู่ในโปรเจกต์ (idempotent) ห้ามให้ทำมือแล้วไม่บันทึก
- Bucket เป็น **private** เสมอ
- อัปโหลด/ดาวน์โหลดใช้ **presigned URL** ให้ไฟล์ไหลระหว่าง browser กับ storage โดยตรง
- presigned URL ต้องเซ็นด้วย host ที่ browser เข้าถึงได้จริง จึงแยก `S3_PUBLIC_ENDPOINT` ออกจาก `S3_ENDPOINT`
- ต้องตั้ง CORS ที่ bucket ให้อนุญาต origin ของ web เพื่ออัปโหลดจาก browser (ตรวจว่าใช้งานได้จริงบนเวอร์ชันที่ pin)
- object key ใช้ UUID เช่น `documents/{uuid}` ห้ามใช้ชื่อไฟล์ต้นฉบับ ให้เก็บชื่อเดิมไว้ในฐานข้อมูล
- ตาราง `files` เก็บ: bucket, object_key, original_name, mime_type, size, uploaded_by, created_at
- ตรวจชนิดไฟล์ (allowlist) และขนาดสูงสุดก่อนออก presigned URL
- ตรวจสิทธิ์ผู้ใช้ก่อนออก presigned URL ทุกครั้ง และตั้งอายุสั้น (5-15 นาที)
- ถ้าลบข้อมูลที่ผูกกับไฟล์ ต้องจัดการลบ object ให้สอดคล้องกัน

## 12. Migration (node-pg-migrate)
- **ทุกการเปลี่ยน schema ต้องทำผ่าน migration เท่านั้น**
- **ห้ามแก้ไฟล์ migration ที่ commit หรือรันไปแล้ว** ให้สร้างไฟล์ใหม่แทน
- ทุก migration ต้องเขียนทั้ง `up` และ `down`
- 1 migration ทำ 1 เรื่อง ตั้งชื่อสื่อความหมาย เช่น `create-users-table`
- ข้อมูลตั้งต้น (roles, permissions) ใส่ใน migration แบบ idempotent
- การลบคอลัมน์/ตาราง หรือเปลี่ยนชนิดข้อมูล ต้องถามผู้ใช้ก่อนเสมอ
- ก่อนสรุปว่าเสร็จ ให้ลองรัน `up` และ `down` บน `app_dev`
- ไฟล์ migration เป็น `.sql` แบ่งส่วนด้วยคอมเมนต์ `-- Up Migration` และ `-- Down Migration` (สร้างด้วย `pnpm --filter api migrate create ชื่อ`)
- `id` ใช้ `uuid DEFAULT uuidv7()` และทุกตารางที่มี `updated_at` ต้องผูก trigger `set_updated_at()`
- ฐาน `app_test` ถูก migrate อัตโนมัติตอนเริ่ม `pnpm test` (หรือรันเองด้วย `pnpm --filter api migrate:test up`)

## 13. ความปลอดภัย
- ห้ามใส่ secret (Google client secret, S3 key, DB password) ในโค้ดหรือ commit
- ห้าม log ข้อมูลอ่อนไหว (token, session, ข้อมูลส่วนบุคคล)
- ข้อมูลส่วนบุคคล (ชื่อ, email, รูป) ต้องเป็นไปตาม PDPA เก็บเท่าที่จำเป็น
- ตั้งชื่อ cookie เฉพาะโปรเจกต์ เพราะ cookie บน `localhost` ใช้ร่วมกันทุก port
- OAuth redirect URI ที่ลงทะเบียนกับ Google ต้องตรงกับ `GOOGLE_REDIRECT_URI` ทุกตัวอักษร

## 14. Frontend (Next.js + Tailwind)
- ใช้ App Router ค่าเริ่มต้นเป็น Server Component ใช้ `"use client"` เฉพาะที่ต้องมี interaction
- **Next.js ทำหน้าที่แสดงผลเท่านั้น** ห้ามใส่ business logic หรือ query ฐานข้อมูล
- Server Component เรียก API ผ่าน `API_URL` และ **ต้องส่งต่อ cookie ของผู้ใช้เอง** (อ่านจาก `cookies()` แล้วใส่ header `Cookie`) ไม่เช่นนั้น API จะมองว่ายังไม่ login
- Client Component ใช้ `NEXT_PUBLIC_API_URL` พร้อม `credentials: 'include'`
- ใช้ middleware ของ Next.js เพื่อ redirect ผู้ที่ยังไม่ login ไปหน้า login (เพื่อ UX เท่านั้น)
- จัดสไตล์ด้วย Tailwind utility class ไม่เขียน CSS แยกยกเว้นจำเป็น
- ทุกหน้าต้องมีสถานะ loading, error และ empty state และมีหน้า "ไม่มีสิทธิ์เข้าถึง"
- รองรับหน้าจอมือถือ (responsive)
- ออกแบบแบบ Mobile-First ตาม `docs/design/ui-guidelines.md` (ระบบสี/ตัวอักษร, โครงหน้า, ขนาดพื้นที่แตะ, การแจ้งเตือน, การขยายไป desktop)

## 15. การทดสอบ
- ฟังก์ชันใหม่ทุกตัวต้องมี test แก้บั๊กต้องเพิ่ม test ที่ครอบคลุมบั๊กนั้น
- **test ของ repository ต้องรันกับ PostgreSQL จริง** (`app_test`) ห้าม mock ฐานข้อมูล
- test ของ route ใช้ `supertest` กับ `app.ts` (ไม่ต้องเปิด port)
- ต้องมี test สิทธิ์: ผู้ใช้ที่มี/ไม่มี permission เข้า endpoint ได้/ไม่ได้ตามที่ควร, ผู้ใช้หลาย role ได้สิทธิ์รวมกันถูกต้อง และกฎการให้/ถอน role ในหัวข้อ 9
- Google login ใน test ให้ mock เฉพาะการเรียก Google (ไม่ mock ฐานข้อมูล)
- รัน `pnpm test`, `pnpm lint`, `pnpm typecheck` ให้ผ่านทั้งหมดก่อนสรุปว่างานเสร็จ

## 16. Git Workflow
- branch: `feature/ชื่องาน`, `fix/ชื่อบั๊ก` ห้าม push ตรงเข้า `main`
- commit message: `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`
- 1 commit ทำ 1 เรื่อง

## 17. วิธีทำงานร่วมกับ Claude
- **ก่อนแก้โค้ด:** อ่านไฟล์ที่เกี่ยวข้อง แล้วอธิบายแผนสั้น ๆ ก่อนลงมือ
- **งานใหญ่:** แตกเป็นขั้นตอนย่อย ทำทีละขั้นและสรุปผลทุกขั้น
- **ต้องถามก่อนทำเสมอ:** ลบไฟล์, เปลี่ยน schema ที่มีข้อมูลอยู่แล้ว, เพิ่ม dependency ใหม่, เปลี่ยนโครงสร้างโฟลเดอร์, เปลี่ยน port/image ใน docker-compose, แก้ระบบ auth หรือกฎสิทธิ์
- **เมื่อไม่แน่ใจ:** ถามกลับ อย่าเดาความต้องการ
- **ถ้าพบ `[...]` ที่ยังไม่กรอกและเกี่ยวข้องกับงานที่ทำ** (เช่น ยังไม่กำหนด role/permission) ให้ถามผู้ใช้ก่อน ห้ามเดาค่าเอง
- **การตอบ:** ตอบเป็นภาษาไทย กระชับ และอธิบายเหตุผลของ SQL ที่เขียนให้เข้าใจง่าย เพราะผู้พัฒนาเน้นทำงานกับ SQL โดยตรง
- **สรุปท้ายงาน:** บอกว่าแก้ไฟล์ไหนบ้าง และต้องรันคำสั่งอะไรต่อ (เช่น migration)

## 18. ข้อควรระวังเฉพาะโปรเจกต์
> **สถานะ:** โปรเจกต์เริ่มสร้างใหม่ทั้งหมดเมื่อ 2026-10-06 ERP-HR สร้างแล้ว (2026-10-08) ส่วนต่อไปนี้ **ยังไม่ได้สร้าง** และไฟล์ที่อ้างถึงยังไม่มีอยู่จริง: หน้าจับคู่หน่วยงาน ERP แบบ `manual`, PDPA (`/privacy`, `PrivacyNotice.tsx`, `privacy-service.ts`, `docs/design/pdpa.md`), อีเมลแจ้งเตือน (`src/mail`), deploy/CI (`/deploy`, `.github/workflows`, `docs/deployment.md`) — กฎด้านล่างใช้เมื่อเริ่มพัฒนาส่วนนั้น
- **ERP-HR** (`ERP_HR_STAFFINFO_URL`): เรียกด้วย Google access token ของผู้ใช้ตอน callback เท่านั้น ห้ามเก็บ access token ลงฐานข้อมูลหรือ log เรียกนอก transaction และถ้าล้มเหลวต้องไม่ทำให้ login ล้ม (รายละเอียด API: `docs/erp_hr_msu_staff_info_integration.md`)
- ข้อมูลบุคลากรเก็บที่ `staff_profiles` (รหัสบุคลากร, ชื่อไทย/อังกฤษ, ตำแหน่ง, คณะ/กอง/กลุ่มงาน) อัปเดตทุกครั้งที่ login ถ้า ERP ล้มเหลวใช้ข้อมูลเดิม — `users.display_name` ของบุคลากร = ชื่อ-นามสกุลไทยจาก ERP (ไม่มีคำนำหน้า) ส่วนนิสิต/บุคลากรภายนอก = ชื่อจาก Google ทุกหน้าที่แสดงชื่อผู้ใช้ต้องใช้ `display_name`
- รหัสหน่วยงานของ ERP (`facultyid`/`departmentid` 12 หลัก) เป็นคนละชุดกับ `org_units.code` (2 หลัก) ห้ามนำมาเทียบกันตรง ๆ ให้ผูกผ่านตาราง `erp_org_units` (จับคู่ด้วยรหัส ERP, ระบบจับคู่จากชื่อที่ตรงกันให้อัตโนมัติ, การจับคู่แบบ `manual` ห้ามถูกทับ) หน่วยงานของบุคลากรใช้ระดับกอง/ฝ่ายก่อน แล้วค่อยคณะ/สำนัก
- ไม่เก็บเบอร์โทรศัพท์จาก ERP (PDPA)
- **PDPA:** ระบบมีประกาศความเป็นส่วนตัวเฉพาะบริการ (`/privacy`, อ้างนโยบายมหาวิทยาลัยและประกาศสำหรับบุคลากร) ผู้ใช้ต้องกด "รับทราบ" ก่อนใช้ระบบ ฐานหลักคือประโยชน์โดยชอบด้วยกฎหมาย (ไม่ใช้ความยินยอมเป็นเงื่อนไขการใช้ระบบ) ดู `docs/design/pdpa.md`
  - เพิ่ม/เปลี่ยนการเก็บหรือเปิดเผยข้อมูลส่วนบุคคล → ต้องแก้ข้อความใน `apps/web/src/components/privacy/PrivacyNotice.tsx` และเพิ่มเวอร์ชันให้ตรงกันทั้ง web และ `apps/api/src/services/privacy-service.ts` (ผู้ใช้ทุกคนต้องรับทราบใหม่) และให้ DPO ตรวจข้อความก่อน deploy
  - คำร้องใช้สิทธิ์ (แก้ไข/ลบ/คัดค้าน) ส่งต่อ DPO ของมหาวิทยาลัย (dpo@msu.ac.th)
