# ระบบใบรับรองดิจิทัลแบบบริการตนเอง (Self-service)

ออกแบบร่วมกับผู้พัฒนาเมื่อ 2026-10-08 — การลงนามเอกสารบนเว็บดู `docs/design/document-signing.md`

## เป้าหมาย

แทนที่การออกใบรับรองด้วยสคริปต์ OpenSSL บน Ubuntu (ทีละคน/เป็นชุด) ด้วยระบบที่ผู้ใช้ทำเองได้โดยไม่ต้องรอเจ้าหน้าที่:

- ขอใบรับรอง S/MIME ของตัวเอง และตั้งรหัสผ่านไฟล์ `.p12` เอง
- ดาวน์โหลดไฟล์ `.p12` ใหม่ (กู้ key จาก key สำรอง) เมื่อทำไฟล์หายหรือลืมรหัสผ่าน
- เพิกถอนใบรับรองของตัวเอง และ CRL อัปเดตอัตโนมัติ
- เห็นใบรับรองเดิมที่ออกด้วยสคริปต์ (นำเข้าจาก `index.txt`)

## ระบบเดิม (ข้อมูลจากผู้พัฒนา)

- Intermediate CA: key `private/univ-ca.key.pem` (มี passphrase), cert `certs/univ-ca.cert.pem`, จัดการด้วย `openssl ca` (OpenSSL 1.1.1) ฐานข้อมูล `index.txt`
- สคริปต์ออกใบ: สุ่มรหัสผ่านด้วย `pwgen 16` → RSA 4096 (`-aes256`) → CSR → `openssl ca -extensions smime` → `.p12` (รวม `univ-ca.cert.pem`) → เขียน `อีเมล,ไฟล์,รหัสผ่าน` ลง `pkcs12-files.csv`
- serial สุ่ม 128 บิต (`openssl rand -hex 16`), อายุ 365 วัน, SHA-256
- CRL: `openssl ca -gencrl` ได้ `univ-ca.crl` แล้วผู้พัฒนาเปลี่ยนชื่อเป็น `msu-ca.crl` นำขึ้น `https://cdp.msu.ac.th/msu-ca.crl` ด้วยมือ (`default_crl_days = 30`) ไม่มี OCSP/AIA

ข้อที่ระบบใหม่ต้องแก้: private key + รหัสผ่านของผู้ใช้อยู่คู่กันแบบไม่เข้ารหัส (`private/` + CSV), passphrase ของ CA อยู่ในสคริปต์และเห็นได้จาก `ps`, การเพิกถอนต้องรอนำ CRL ขึ้นด้วยมือ

## การตัดสินใจ

| เรื่อง | ข้อสรุป |
|---|---|
| ประเภทใบรับรอง | S/MIME ตาม `[ smime ]` เดิมทุก extension (ลงนาม + เข้ารหัสอีเมล) |
| Subject | `C=TH, O=Mahasarakham University, CN=<ชื่อไทย>, emailAddress=<อีเมล>` เข้ารหัส UTF8String — ระบบกำหนดจากฐานข้อมูลเท่านั้น ผู้ใช้แก้ไม่ได้ |
| ชื่อใน CN | ภาษาไทย = `users.display_name` (บุคลากรได้จาก ERP; นิสิต/บุคลากรภายนอก/บัญชีหน่วยงาน = ชื่อจาก Google หรือที่ผู้ดูแลแก้) |
| Key สำรอง (escrow) | **ต้องมี** — เพราะใบรับรองใช้เข้ารหัสอีเมล ถ้า key หายจะเปิดอีเมลเก่าไม่ได้ |
| ที่สร้าง private key | บริการเซ็น (ฝั่ง server) เพราะต้องเก็บสำรองอยู่แล้ว — สร้างใน browser ไม่ได้ประโยชน์เพิ่ม |
| รหัสผ่าน `.p12` | ผู้ใช้ตั้งเองทุกครั้งที่ดาวน์โหลด **ระบบไม่เก็บรหัสผ่าน** (ไม่มี CSV แบบเดิม) |
| CRL | URL เดิม `https://cdp.msu.ac.th/msu-ca.crl` (ใบเดิมฝังไว้แล้ว เปลี่ยนไม่ได้) ระบบออก CRL ใหม่ทุกครั้งที่เพิกถอน และทุกวัน |
| อายุ CRL | 7 วัน (`CRL_VALIDITY_DAYS`, ระบบเดิม 30) — ผู้ตรวจอาจใช้ CRL ที่เก็บไว้จนถึง next update จึงสั้นลงให้การเพิกถอนมีผลเร็วขึ้น; ถ้า cron ของ cdp หยุดเกิน 7 วัน CRL จะหมดอายุ |
| เลข CRL | เวลา Unix (วินาที) และเพิ่มขึ้นเสมอ — มากกว่าเลขจาก `crlnumber` ของระบบเดิมแน่นอน จึงไม่ต้องนำเข้า `crlnumber` |
| รูปแบบไฟล์ CRL | PEM (`CRL_PUBLISH_FORMAT=pem`) เหมือนไฟล์ที่ `openssl ca -gencrl` สร้างแล้วเปลี่ยนชื่อขึ้น cdp — เปลี่ยนเป็น DER ได้ |
| เหตุผลการเพิกถอน (ผู้ใช้เลือก) | `keyCompromise`, `superseded`, `affiliationChanged`, `cessationOfOperation` — `unspecified`/`CACompromise` สงวนไว้ให้ระบบ/ผู้ดูแล |
| ใบรับรองเดิม | นำเข้าจาก `index.txt` + `newcerts/` (ใบรับรองและสถานะเพิกถอน) |
| หลังเปิดระบบ | **เลิกใช้ `openssl ca` บน Ubuntu ออกใบ/เพิกถอน** — ถ้าออกสองที่ serial, `index.txt` และ CRL จะไม่ตรงกัน |

## โครงสร้าง

```
browser ──► web (Next.js) ──► api (Express) ──► signer (บริการเซ็น, เครือข่ายภายในเท่านั้น)
                                   │                 ├─ Intermediate CA key (ไฟล์ mount read-only)
                                   │                 └─ key ห่อ escrow (KEK)
                                   └─► PostgreSQL (ใบรับรอง, escrow ที่เข้ารหัสแล้ว, CRL, audit log)

cdp.msu.ac.th ──(cron ดึง)──► GET /crl/msu-ca.crl (public)
```

- **บริการเซ็นแยก (`apps/signer`)** (อนุมัติแล้ว): แยกเป็น container ของตัวเอง ถือ CA key และ KEK ไว้คนเดียว API หลักและฐานข้อมูลไม่เคยเห็น key ดิบ เรียกจาก API ผ่านเครือข่ายภายในพร้อม token ร่วม ถ้า API ถูกเจาะ CA key และ key ของผู้ใช้ไม่หลุด
- passphrase ของ CA และ KEK ส่งผ่าน Docker secret / env ของ signer เท่านั้น ห้ามส่งเป็น argument บรรทัดคำสั่ง (เห็นใน `ps`)
- **CA ที่ใช้ออกใบ:** Intermediate ของมหาวิทยาลัย `Mahasarakham University Certification Authority` (`apps/signer/ca/univ-ca.cert.pem`, หมดอายุ 2033-04-25, pathlen:0) ออกโดย root `Thai University Consortium Certification Authority` (`apps/signer/ca/root.cert.pem`, หมดอายุ **2030-03-25**) — repo เก็บเฉพาะใบรับรองสาธารณะ key `univ-ca.key.pem` อยู่บนเครื่อง production ของ signer เท่านั้น
- **สายใบรับรองใน `.p12`:** ใบผู้ใช้ + Intermediate + ใบใน `CA_CHAIN_PATH` (root) — signer ตรวจตอนเริ่มระบบว่าทุกใบเป็น CA และเซ็นใบที่อยู่ถัดลงมาจริง ไม่ผ่าน = ไม่เริ่มทำงาน
- **ให้ผู้ตรวจลายเซ็นเชื่อถือ root:** หน้า `/root-ca` (public ไม่ต้อง login) แจก `tuc-root-ca.cer` (DER) พร้อม fingerprint และวิธีตั้งค่า trust ใน Acrobat/Foxit — สำเนา root อยู่ที่ `apps/web/src/lib/root-ca.ts` ต้องตรงกับ `apps/signer/ca/root.cert.pem` (test ใน signer ตรวจ) ใช้แทนไฟล์ `TUCTrustedCert.fdf` เดิมที่ลายเซ็นของไฟล์หมดอายุแล้ว
  - หน้าเดียวกันแนะนำให้ผู้ลงนามตั้ง Timestamp Server ใน Acrobat/Foxit (ตอนนี้ใช้ TSA สาธารณะ `http://timestamp.digicert.com` ใน `apps/web/src/app/root-ca/page.tsx`) — ไม่มี timestamp ลายเซ็นจะใช้เวลาจากนาฬิกาเครื่องผู้ลงนาม และตรวจไม่ผ่านหลังใบหมดอายุ/ถูกเพิกถอน เมื่อ TSA ของมหาวิทยาลัยพร้อม (ระยะ S4 ใน `document-signing.md`) ให้เปลี่ยน URL
- **อายุใบไม่เกินอายุ CA:** อายุใบ = ตามนโยบาย (ไม่เกินเพดาน `CERT_VALIDITY_DAYS`) แต่ไม่เกินวันหมดอายุที่เร็วที่สุดของ Intermediate/root (ใบที่ออกหลัง 2029-03-25 จะสั้นกว่า 365 วัน) เหลือไม่ถึง 1 วัน = signer ปฏิเสธ (`CA_EXPIRING`) — ต้องติดตามการต่ออายุ root ของ TUC ก่อน 2030-03-25 แล้วเปลี่ยนไฟล์ `CA_CHAIN_PATH`
- **การนำ CRL ขึ้น cdp:** ระบบเปิด `GET /crl/msu-ca.crl` (public) แล้วเครื่อง `cdp.msu.ac.th` ใช้ cron ดึงทุก 5–15 นาที — ผู้พัฒนาดูแล cdp เอง จึงไม่ต้องให้ระบบมีสิทธิ์เขียนเข้า cdp

## ขั้นตอนหลัก

**ขอใบรับรอง** (ต้อง login + permission `certificate:request` — ดูหัวข้อสิทธิ์)
1. ผู้ใช้กดขอใบรับรองและตั้งรหัสผ่าน `.p12` (ตรวจความยาวขั้นต่ำ)
2. API ตรวจสิทธิ์ สถานะบัญชี (approved, active, ไม่หมดอายุ) และจำนวนใบที่ใช้งานอยู่ แล้วส่ง subject ให้ signer
3. signer สร้าง RSA 4096 → เซ็นด้วย extensions `smime` → เข้ารหัส key ด้วย KEK (escrow) → สร้าง `.p12` ด้วยรหัสผ่านของผู้ใช้
4. API บันทึกใบรับรอง + escrow + audit log ใน transaction เดียว แล้วส่ง `.p12` ให้ดาวน์โหลดครั้งเดียว (ไม่เก็บไฟล์ `.p12` ไว้)

**ดาวน์โหลดใหม่ / กู้ key** — ผู้ใช้ตั้งรหัสผ่านใหม่ signer ถอด escrow แล้วสร้าง `.p12` ใหม่ (ใบรับรองเดิม ไม่ออกใบใหม่) เขียน audit log ทุกครั้ง — ใบที่หมดอายุ/เพิกถอนแล้วยังดาวน์โหลดได้เพื่อเปิดอีเมลเก่า (หน้าเว็บแสดงเป็นปุ่มรอง "ดาวน์โหลดไว้เปิดอีเมลเก่า") ยกเว้นเพิกถอนเพราะ key อาจหลุด (`keyCompromise`)

**เพิกถอน** — ผู้ใช้เลือกใบของตัวเอง + เหตุผล → บันทึก `revoked_at` → signer ออก CRL ใหม่ทันที (`crl_number` = เวลา Unix เพิ่มขึ้นเสมอ)

## ความเข้ากันได้ของ `.p12`

OpenSSL 3 สร้าง `.p12` แบบ AES-256 + PBKDF2 เป็นค่าเริ่มต้น ส่วน OpenSSL 1.1.1 (ระบบเดิม) ใช้ 3DES/RC2 — โปรแกรมรุ่นเก่า (Windows/Outlook รุ่นเก่า, macOS Keychain บางรุ่น) เปิดแบบ AES ไม่ได้
- ใช้ AES เป็นค่าเริ่มต้น และมีตัวเลือก "ไฟล์สำหรับโปรแกรมรุ่นเก่า" (3DES) ในหน้าดาวน์โหลด — ต้องทดสอบนำเข้าจริงกับโปรแกรมที่บุคลากรใช้ก่อนเปิดระบบ
- signer ใช้ OpenSSL ใน container (pin เวอร์ชัน) ไม่ผูกกับ OpenSSL 1.1.1 บน Ubuntu (หมดการสนับสนุนแล้วตั้งแต่ ก.ย. 2023)

## Key สำรอง (escrow)

- private key เข้ารหัสด้วย AES-256-GCM ต่อ key (data key) แล้วห่อ data key ด้วย KEK ของ signer เก็บใน PostgreSQL เฉพาะ ciphertext (`kek_id` เพื่อรองรับการเปลี่ยน KEK)
- KEK อยู่ที่ signer เท่านั้น — สำรอง KEK แยกเก็บออฟไลน์ ถ้า KEK หาย key สำรองทั้งหมดใช้ไม่ได้
- **การกู้ key:** ผู้ใช้กู้เองได้ ไม่ต้องรออนุมัติ (login Google ยืนยันตัวตนแล้ว) + audit log + แจ้งเตือนทางอีเมลเมื่อระบบอีเมลพร้อม
- **นำเข้า key เดิม:** ไฟล์ `private/*.key.pem` + รหัสผ่านใน `pkcs12-files.csv` นำเข้า escrow ได้ ผู้ใช้ดาวน์โหลดใบเดิมใหม่และใช้ลงนามเอกสารบนเว็บได้ — นำเข้าแล้ว **ทำลาย `private/` และ CSV** บน Ubuntu หลังตรวจว่านำเข้าครบ

## สิทธิ์ (ยืนยันแล้ว)

| permission | คำอธิบาย |
|---|---|
| `certificate:request` | ขอ/ดาวน์โหลด/เพิกถอนใบรับรอง **ของตัวเอง** |
| `document:sign` | ลงนามเอกสารด้วยใบรับรองของตัวเอง (ดู `document-signing.md`) |
| `certificate:read` | ดูรายการใบรับรองของผู้อื่น |
| `certificate:revoke` | เพิกถอนใบรับรองของผู้อื่น |
| `certificate_policy:manage` | กำหนดนโยบายอายุใบรับรองประจำตัวและเพดานของใบรับรองเสริม (ยืนยัน 2026-10-24) |
| `supplementary_certificate:request` | ขอ รับ ดาวน์โหลด และเพิกถอนใบรับรองเสริม **ของตัวเอง** (ยืนยัน 2026-10-24) |
| `certificate:approve` | ดู อนุมัติ และปฏิเสธคำขอใบรับรองเสริมของผู้อื่น (ยืนยัน 2026-10-24) |

- ใช้ permission แทนการเปิดให้ "login เท่านั้น" เพราะยังไม่ชัดว่าทุกประเภทบัญชี (เช่น นิสิต) ได้ใบรับรอง — `super_admin` ผูกกับ role `staff`/`student`/... ได้เองภายหลัง ระหว่างนี้ใช้ได้เฉพาะ `super_admin` (ค่าเริ่มต้นคือปฏิเสธ)
- การนำเข้าใบเดิมทำผ่านสคริปต์ (`pnpm --filter api cert:import`) ไม่มีหน้าเว็บ จึงไม่ต้องมี permission
- ใบประจำตัวที่ใช้งานอยู่ 1 ใบต่อคน ขอใบใหม่ได้ในช่วงต่ออายุ (ดูหัวข้อถัดไป) — แทนกฎเดิม "ใช้งานพร้อมกันได้ไม่เกิน 2 ใบ"
- ปิดบัญชี/ลบข้อมูลส่วนบุคคล/บัญชีหมดอายุ → เพิกถอนใบที่ใช้งานอยู่อัตโนมัติ (`cessationOfOperation`, audit ผู้ทำ = ผู้ดูแล หรือ NULL เมื่อระบบทำ) แล้วออก CRL; เปิดบัญชีคืนไม่ย้อนการเพิกถอน
- ลบข้อมูลส่วนบุคคล (PDPA): นอกจากเพิกถอนแล้ว ลบ key สำรอง และล้าง `subject_cn`, `email`, `certificate_pem` — คงแถวพร้อม serial/วันหมดอายุ/การเพิกถอนไว้ให้ CRL

## ตาราง

- `certificates`: `id`, `user_id` (NULL ได้ถ้านำเข้าแล้วยังไม่พบผู้ใช้), `serial_number` (hex, UNIQUE), `subject_cn`, `email`, `not_before`, `not_after`, `revoked_at`, `revocation_reason`, `revoked_by`, `source` (`issued`/`imported`), `kind` (`primary`/`supplementary`, ค่าเริ่มต้น primary), `certificate_pem`, `fingerprint_sha256`, `created_at`, `updated_at` — ไม่มี soft delete (ใบรับรองลบไม่ได้ ต้องอยู่ใน CRL)
- `certificate_key_escrows`: `certificate_id` (PK), `encrypted_key`, `wrapped_data_key`, `kek_id`, `created_at`, `updated_at` — แยกตารางเพื่อให้ query รายการใบรับรองไม่แตะ blob
- `crls`: `crl_number` (bigint UNIQUE), `this_update`, `next_update`, `revoked_count` (จำนวนใบที่เพิกถอนตอนออก — จำนวนปัจจุบันมากกว่า = ต้องออกใหม่), `crl_der`, `created_at`, `updated_at` — เก็บทุกฉบับ
- `certificate_audit_logs`: `certificate_id`, `actor_id`, `action` (`issue`/`recover`/`revoke`/`import`/`sign`), `reason`, `created_at` — แก้/ลบไม่ได้
- `certificate_policies`: แถวเดียว (`id` = true) — `primary_mode`, `primary_days`, `primary_expiry_month`, `primary_expiry_day`, `primary_min_days`, `renewal_window_days`, `supplementary_max_days`, `supplementary_max_active`, `supplementary_max_lead_days`, `updated_by`
- `certificate_policy_logs`: `actor_id`, `before`, `after` (jsonb ค่าทั้งชุด), `created_at` — แก้/ลบไม่ได้
- `supplementary_certificate_requests`: `user_id`, `purpose`, `requested_start/end` และ `approved_start/end` (date ตามเวลาไทย), `status` (`pending`/`approved`/`issued`/`rejected`/`cancelled` — "หมดเวลา" คำนวณจาก `approved_end` ไม่เก็บ), `decided_by`, `decided_at`, `decision_note`, `certificate_id` (UNIQUE), `created_at`, `updated_at`
- `supplementary_certificate_request_logs`: `request_id`, `actor_id` (NULL = ระบบ), `action` (`submit`/`approve`/`reject`/`cancel`/`issue`), `range_start`, `range_end`, `created_at` — แก้/ลบไม่ได้, ไม่เก็บวัตถุประสงค์/บันทึก (PDPA)

## นำเข้าใบเดิม

คำสั่ง: `pnpm --filter api cert:import -- --dir <โฟลเดอร์ CA เดิม> [--passwords <pkcs12-files.csv>] [--dry-run]` (ต้องเปิด signer)

- อ่าน `index.txt` (สถานะ `V`/`R`/`E`, วันหมดอายุ, วัน+เหตุผลเพิกถอน, serial) คู่กับไฟล์ใบใน `newcerts/` และ `certs/` (จับคู่ด้วย serial, ข้ามใบของ CA) — ชื่อ/อีเมลอ่านจากใบรับรอง ไม่ใช่จาก index (index เก็บชื่อไทยแบบ escape)
- **ตรวจเข้ม:** ใบใน index ที่หาไฟล์ไม่เจอ หรือเหตุผลการเพิกถอนที่ไม่รองรับ (`certificateHold`, `removeFromCRL`) = หยุดทั้งหมด ไม่เขียนอะไร — ใบที่เพิกถอนต้องครบ เพราะ CRL ของระบบใหม่แทนฉบับเดิม
- คงวันและเหตุผลเพิกถอนเดิม (ไม่มีเหตุผล = `unspecified`, `keyTime` = `keyCompromise`)
- ผูกกับผู้ใช้ด้วยอีเมลในใบ (ไม่สนตัวพิมพ์); ไม่พบ = `user_id` NULL แล้วผูกอัตโนมัติเมื่อผู้ใช้ login (เงื่อนไขเดียวกับการผูกบัญชีลงทะเบียนล่วงหน้า: อีเมลโดเมน มมส. ต้องมี `hd` ตรง)
- **key เดิม:** `private/<อีเมล>.key.pem` + รหัสผ่านทุกบรรทัดของอีเมลนั้นใน `pkcs12-files.csv` (ล่าสุดก่อน) ส่งให้ signer ถอดและจับคู่กับใบด้วย public key (สคริปต์เดิมเขียนทับ key ทุกครั้งที่ออกใบใหม่ จึงมีแค่ key ของใบล่าสุด) — ถอดไม่ได้/ไม่คู่ = คำเตือน ใบยังนำเข้าได้แต่ไม่มี key สำรอง
- ไม่ต้องนำเข้า `crlnumber` (เลข CRL ของระบบใหม่ใช้เวลา Unix ซึ่งมากกว่าเสมอ)
- รันซ้ำได้: ข้ามใบที่มีแล้ว แต่รับการเพิกถอนที่เพิ่มขึ้นในระบบเดิม และเก็บ key สำรองที่ยังไม่มี; ทุกใบเขียน audit `import`
- ออก CRL ใหม่ทันทีหลังนำเข้า

**ลำดับการย้ายระบบ (สำคัญ):**
1. deploy API + signer (ใช้ Intermediate CA key จริง) — ยัง **ไม่** ตั้ง cron บน cdp
2. หยุดใช้ `openssl ca` บน Ubuntu แล้วคัดลอกโฟลเดอร์ CA (ไม่ต้องมี CA key) ไปเครื่อง API ชั่วคราว
3. `cert:import --dry-run` → ตรวจรายงาน → รันจริง
4. ตรวจ `/crl/msu-ca.crl` ว่ามีใบที่เพิกถอนเดิมครบ (`openssl crl -noout -text`) แล้วจึงตั้ง cron บน cdp — ถ้าตั้ง cron ก่อนนำเข้า CRL ว่างจะทับฉบับเดิม ใบที่เคยเพิกถอนจะกลับมาใช้ได้
5. ลบสำเนาโฟลเดอร์ CA และทำลาย `private/` + `pkcs12-files.csv` บน Ubuntu (key และรหัสผ่านอยู่ใน key สำรองที่เข้ารหัสแล้ว)

## ใบประจำตัว / ใบเสริม / นโยบายอายุ (ตัดสินใจ 2026-10-24)

| ประเภท (`certificates.kind`) | ใครขอ | จำนวน | อายุ | การใช้งาน |
|---|---|---|---|---|
| `primary` ใบประจำตัว | ผู้ใช้ขอเอง (`certificate:request`) | ใช้งานอยู่ 1 ใบ — ขอใบใหม่ได้เมื่อใบเดิมเหลือ ≤ `renewal_window_days` (ใบเดิมใช้ต่อจนหมดอายุ) | ตามนโยบาย | S/MIME (ลงนาม + เข้ารหัสอีเมล) |
| `supplementary` ใบเสริม | ผู้ใช้ส่งคำขอ (`supplementary_certificate:request`: วัตถุประสงค์ + ช่วงวันที่) → ผู้มี `certificate:approve` อนุมัติ (แก้ช่วงได้) → ผู้ใช้กดรับใบ | ใบที่ใช้งานอยู่ + คำขอที่ค้าง ≤ `supplementary_max_active` | ช่วงวันที่ ≤ `supplementary_max_days` วัน | ลงนามเอกสารเท่านั้น (หัวข้อถัดไป) |

- **ชื่อเรียก:** ใบของผู้ใช้ = "ใบรับรองประจำตัว" (`primary` ในโค้ด/ฐานข้อมูล) — คำว่า "ใบรับรองหลัก" สงวนไว้หมายถึง root CA (หน้า `/root-ca`) ห้ามใช้เรียกใบของผู้ใช้
- ใบเดิมทั้งหมด (รวมที่นำเข้า) เป็นใบประจำตัว ผู้ที่มีใบที่ใช้งานอยู่ 2 ใบจากกฎเดิมใช้ต่อได้ — กฎใหม่ตรวจเฉพาะตอนขอใบใหม่
- **นโยบายอายุ** (`certificate_policies` แถวเดียว, หน้า `/admin/certificate-policy`, ประวัติใน `certificate_policy_logs` แก้/ลบไม่ได้) มีผลกับใบที่ออกหลังแก้เท่านั้น
  - `days`: อายุ `primary_days` วันนับจากวันที่ออก (ค่าเริ่มต้น 365)
  - `fixed_date`: หมดอายุวัน/เดือนที่กำหนดของทุกปี เช่น 31 ธ.ค. (เวลาประเทศไทย) ถ้าเหลือน้อยกว่า `primary_min_days` (ค่าเริ่มต้น 60) ใช้ปีถัดไป — ปัดลงเป็นวันเต็ม ใบจึงหมดอายุวันที่กำหนด ณ เวลาเดียวกับที่ออก
  - ช่วงต่ออายุต้องสั้นกว่าอายุสั้นสุดของใบประจำตัว (`POLICY_INVALID`) ไม่เช่นนั้นผู้ใช้ขอใบประจำตัวใหม่ได้ตลอด
- API คำนวณจำนวนวันแล้วส่ง `validityDays` ให้ signer ซึ่งยังตัดให้ไม่เกิน **เพดาน** `CERT_VALIDITY_DAYS` (ค่าเริ่มต้น 825) และอายุของ CA — API ถูกเจาะก็ขอใบอายุยาวผิดปกติไม่ได้; เพดานต้อง ≥ อายุที่นโยบายให้ได้ (โหมด 31 ธ.ค. ได้สูงสุดราว 365 + `primary_min_days` วัน)
- ใบเสริมระยะสั้นต้องประทับเวลา (TSA) ตอนลงนาม ไม่เช่นนั้นหลังใบหมดอายุ ลายมือชื่อจะตรวจได้แค่ "ไม่ทราบความถูกต้อง"

## ใบรับรองเสริม (ตัดสินใจ 2026-10-24)

1. **ส่งคำขอ:** วัตถุประสงค์ + วันเริ่ม/วันสิ้นสุด (วันตามเวลาไทย) — วันเริ่มไม่ย้อนหลังและล่วงหน้าไม่เกิน `supplementary_max_lead_days` (ค่าเริ่มต้น 90), ยาวไม่เกิน `supplementary_max_days` (นับวันแรกและวันสุดท้าย), ชื่อแสดงยาวเกิน 64 ตัวปฏิเสธตั้งแต่ตอนนี้
2. **อนุมัติ/ปฏิเสธ:** กฎ `canDecideSupplementaryRequest` = `canManageUser` (คำขอของตัวเองไม่ได้, คำขอของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin) ยกเว้น super_admin ตัดสินได้ทุกคำขอรวมของตัวเอง (ตัดสินใจ 2026-10-24) ล็อก ผู้ใช้ → คำขอ; อนุมัติแก้ช่วงได้ภายในเพดาน (วันเริ่มผ่านไปแล้วได้ แต่ต้องยังไม่สิ้นสุด) บันทึกถึงผู้ขอไม่บังคับ; ปฏิเสธต้องมีเหตุผล (ผู้ขอเห็น)
3. **รับใบ:** ผู้ขอตั้งรหัส `.p12` เอง แล้วระบบออกใบตอนนั้น (ระบบไม่เก็บรหัส จึงออกตอนอนุมัติไม่ได้) — ได้ตั้งแต่อนุมัติจนสิ้นวันสุดท้าย; ใบเริ่ม 00:00 ของวันแรก (หรือเวลาที่รับ ถ้าช้ากว่า — ไม่ออกย้อนหลัง) ถึง 23:59:59 ของวันสุดท้าย; เก็บ key สำรองเหมือนใบประจำตัว
- ผู้ขอยกเลิกได้ระหว่างรออนุมัติหรือก่อนรับใบ; ปิดบัญชี/ลบบัญชี/บัญชีหมดอายุ = ยกเลิกคำขอที่ค้างอัตโนมัติ (log `cancel` ผู้ทำ = ผู้ดูแล หรือ NULL); ลบข้อมูลส่วนบุคคลล้าง `purpose` และ `decision_note`
- เพดานจำนวนนับคำขอที่ค้างด้วย กันส่งหลายคำขอแล้วได้ใบเกินเมื่ออนุมัติพร้อมกัน — ตรวจตอนส่ง (ต้องมีช่องว่าง), ตอนอนุมัติและตอนรับ (ไม่เกิน) โดยล็อกแถวผู้ใช้ก่อนนับ; `supplementary_max_active = 0` = ปิดรับคำขอ
- เพิกถอน/ดาวน์โหลดใหม่ใช้ endpoint เดียวกับใบประจำตัว แต่ตรวจ permission ตามประเภทใบใน service (route เป็น "ต้อง login") — ใบเสริมที่ใช้ไม่ได้แล้วหน้าเว็บไม่เสนอให้ดาวน์โหลด (ไม่มีอีเมลเก่าให้เปิด)
- **โปรไฟล์ใน signer** (`profile: 'document_signing'`): keyUsage `digitalSignature, nonRepudiation` (critical), EKU `documentSigning` (1.3.6.1.5.5.7.3.36) + Microsoft Document Signing (1.3.6.1.4.1.311.10.3.12) + Adobe Authentic Documents (1.2.840.113583.1.1.5) ไม่มี `emailProtection`; extensions อื่นเหมือน `[ smime ]`; ออกด้วย `openssl ca -startdate/-enddate` กับฐานข้อมูลชั่วคราว (`x509 -req` กำหนดวันเริ่มได้ตั้งแต่ OpenSSL 3.4 แต่เครื่อง dev ใช้ 3.2) ตัดตามเพดาน `CERT_VALIDITY_DAYS` และอายุ CA เหมือนเดิม — **ต้องทดสอบลงนามใน Acrobat/Foxit จริงก่อนใช้งาน**
- หน้าเว็บ: ส่วน "ใบรับรองเสริม" ใน `/certificates`, `/certificates/supplementary/new`, `/certificates/supplementary/[id]/claim`, ผู้อนุมัติ `/admin/certificate-requests` (เมนู "อนุมัติ" สำหรับผู้มี `certificate:approve`)

## API

| Method | Path | สิทธิ์ |
|---|---|---|
| GET | `/me/certificates` | ต้อง login เท่านั้น — ใบของตัวเอง (รวมใบที่นำเข้า, มี `kind`) + `primaryRequest` (`renewableFrom` = วันที่เริ่มขอใบประจำตัวใหม่ได้ / null = ขอได้, `expiresAtIfRequested`, `renewalWindowDays`) |
| POST | `/me/certificates` | `certificate:request` — ออกใบประจำตัว (อายุตามนโยบาย) คืน `.p12` (base64) ครั้งเดียว, `Cache-Control: no-store`; มีใบประจำตัวที่ใช้งานอยู่และยังไม่ถึงช่วงต่ออายุ = 409 `PRIMARY_CERTIFICATE_EXISTS` |
| POST | `/me/certificates/:id/revoke` | ตามประเภทใบ (ใบประจำตัว `certificate:request`, ใบเสริม `supplementary_certificate:request`) — เพิกถอนใบของตัวเอง (เฉพาะใบที่ใช้งานอยู่) แล้วออก CRL ทันที; signer ล่ม = เพิกถอนสำเร็จ (`crlUpdated: false`) แล้ว job ออกให้ภายหลัง |
| POST | `/me/certificates/:id/p12` | ตามประเภทใบ (เหมือนการเพิกถอน) — ดาวน์โหลด `.p12` ใหม่จาก key สำรองด้วยรหัสผ่านใหม่ (ใบเดิม) ได้ทุกสถานะรวมหมดอายุ/เพิกถอน (ไว้เปิดอีเมลเก่า) ยกเว้นเพิกถอนด้วย `keyCompromise` = 409 `KEY_COMPROMISED`, ใบที่ไม่มี key สำรอง = 409 `KEY_NOT_ESCROWED`, audit `recover` |
| GET | `/me/supplementary-certificate-requests` | ต้อง login เท่านั้น — คำขอใบเสริมของตัวเอง (สถานะรวม `expired`) + `limits` (`maxDays`, `maxLeadDays`, `maxActive`, `open`, `today`) |
| POST | `/me/supplementary-certificate-requests` | `supplementary_certificate:request` — ส่งคำขอ (`purpose`, `startDate`, `endDate`); ผิดนโยบาย = 422 `RANGE_INVALID`, เกินเพดาน = 409 `SUPPLEMENTARY_LIMIT_REACHED` |
| POST | `/me/supplementary-certificate-requests/:id/cancel` | `supplementary_certificate:request` — ยกเลิกคำขอของตัวเองที่ยังไม่ออกใบ |
| POST | `/me/supplementary-certificate-requests/:id/certificate` | `supplementary_certificate:request` — รับใบจากคำขอที่อนุมัติแล้ว คืน `.p12` ครั้งเดียว (`no-store`); ยังไม่อนุมัติ = 409 `REQUEST_NOT_APPROVED`, เลยวันสิ้นสุด = 409 `REQUEST_EXPIRED`, รับแล้ว = 409 `REQUEST_ALREADY_ISSUED` |
| GET | `/admin/supplementary-certificate-requests` | `certificate:approve` — `view=pending` (ค่าเริ่มต้น: คิวเก่าก่อน ≤ 100) หรือประวัติ `all`/ตามสถานะ (ล่าสุดก่อน cursor หน้าละ 20) + `pendingCount` + `limits` |
| POST | `/admin/supplementary-certificate-requests/:id/approve` | `certificate:approve` — `startDate`, `endDate`, `note` (ไม่บังคับ) ตามกฎ `canDecideSupplementaryRequest` |
| POST | `/admin/supplementary-certificate-requests/:id/reject` | `certificate:approve` — `note` (บังคับ) ตามกฎ `canDecideSupplementaryRequest` |
| GET | `/crl/msu-ca.crl` | public — CRL ฉบับล่าสุด (`Cache-Control: no-cache`) |
| GET | `/admin/certificates` | `certificate:read` — ค้นหาทั้งระบบ (ชื่อ/อีเมลบางส่วนด้วย trigram, serial ตรงตัว รับ `:`/ตัวพิมพ์ใหญ่), กรองสถานะ, cursor หน้าละ 20, แสดงเจ้าของ |
| GET | `/admin/users/:id/certificates` | `certificate:read` — ใบของผู้ใช้คนหนึ่ง (หน้ารายละเอียดผู้ใช้) |
| GET | `/admin/certificate-policy` | `certificate_policy:manage` — นโยบาย + ประวัติ 20 รายการล่าสุด + ตัวอย่างวันหมดอายุของใบประจำตัว |
| PUT | `/admin/certificate-policy` | `certificate_policy:manage` — แก้นโยบาย (ส่งครบทุกช่อง) ล็อกแถว + log ค่าก่อน/หลัง ใน transaction เดียว |
| POST | `/admin/certificates/:id/revoke` | `certificate:revoke` — เหตุผล (`unspecified`/`keyCompromise`/`affiliationChanged`/`superseded`/`cessationOfOperation`) + บันทึกประกอบ (บังคับ, เก็บใน audit) ใช้กฎ `canManageUser`: ใบของตัวเองไม่ได้ ใบของผู้ดูแลสิทธิ์สูงต้องเป็น super_admin; ล็อก ผู้ใช้ → ใบ (ลำดับเดียวกับการปิดบัญชี) |

บริการเซ็น (`apps/signer`, ต้องมี `Authorization: Bearer <SIGNER_TOKEN>`): `POST /certificates` ออกใบ (`profile` = `smime` ค่าเริ่มต้น + `validityDays` ไม่บังคับ หรือ `document_signing` + `notBefore`/`notAfter` — ตัดตามเพดานและอายุ CA), `POST /certificates/legacy-key` นำ key เดิมเข้าเป็น key สำรอง (ถอดด้วยรหัสผ่าน + จับคู่ใบด้วย public key), `POST /certificates/p12` กู้ key แล้วสร้าง `.p12` ใหม่ (ตรวจว่าใบออกโดย CA นี้, serial ตรง และ key คู่กับใบก่อนเสมอ), `POST /crls` ออก CRL (`openssl ca -gencrl` กับ index.txt ชั่วคราว), `GET /health` (ไม่ต้องใช้ token)

ตั้งค่าบน `cdp.msu.ac.th` (ผู้พัฒนาดูแล): cron ทุก 5–15 นาที ดึง `https://<API>/crl/msu-ca.crl` ลงไฟล์ชั่วคราว ตรวจด้วย `openssl crl -noout` แล้วจึงย้ายทับ `msu-ca.crl` (กันไฟล์เสียเมื่อดึงไม่สำเร็จ)

## ระยะการพัฒนา

| ระยะ | งาน | สถานะ |
|---|---|---|
| 1 | signer + ตาราง + ออกใบรับรองให้ตัวเอง (ดาวน์โหลด `.p12`) + รายการใบของฉัน | เสร็จ |
| 2 | เพิกถอนเอง + ออก CRL + `GET /crl/msu-ca.crl` | เสร็จ |
| 3 | กู้ key / ดาวน์โหลดใหม่ | เสร็จ |
| 4 | สคริปต์นำเข้าใบเดิม + key เดิม | เสร็จ |
| 5 | หน้าผู้ดูแล (ดู/เพิกถอนใบของผู้อื่น), เพิกถอนอัตโนมัติเมื่อปิดบัญชี | เสร็จ |
| 6 | ใบประจำตัว 1 ใบ + ช่วงต่ออายุ + นโยบายอายุใบ (`/admin/certificate-policy`) | เสร็จ |
| 7 | ใบเสริม: คำขอ + อนุมัติ (`certificate:approve`) + โปรไฟล์ลงนามเอกสารอย่างเดียว | เสร็จ (รอทดสอบใน Acrobat) |
| แยก | แจ้งเตือนใบใกล้หมดอายุ (รอระบบอีเมล), OCSP | |
