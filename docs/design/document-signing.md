# ลงนามเอกสารบนเว็บ

ออกแบบครั้งแรก 2026-10-08 ปรับใหม่ 2026-10-25 — ต่อยอดจาก `docs/design/certificates.md`

## เป้าหมาย

ผู้ใช้ใช้ **ใบรับรองประจำตัวหรือใบรับรองเสริมของตัวเอง** ลงลายมือชื่อดิจิทัลบน PDF ผ่านหน้าเว็บ:
- ลงนามอย่างเดียว (มองไม่เห็น) หรือพร้อม **ภาพลายเซ็น** ที่ผู้ใช้ลากวางและย่อขยายเองบนหน้าเอกสาร
- เลือก **ล็อกเอกสาร** หลังลงนาม ไม่ให้แก้ไขต่อได้
- ลงนาม **หลายไฟล์ครั้งเดียว** โดยอัปโหลด ZIP ที่รวม PDF ไว้ (เช่น เกียรติบัตร)

## การตัดสินใจ (ยืนยัน 2026-10-25)

| เรื่อง | ข้อสรุป |
|---|---|
| ชนิดเอกสาร | PDF เท่านั้น ลายมือชื่อฝังในไฟล์ (`adbe.pkcs7.detached`, CMS แบบ CAdES มี signingCertificateV2) ตรวจใน Acrobat/Foxit และหน้า `/verify` ได้ |
| ที่ลงนาม | **server ลงนามด้วย key สำรอง** ผู้ใช้ยืนยันด้วย **PIN ลงนาม** ที่ตั้งเอง (scrypt, ผิด 5 ครั้งล็อก 15 นาที) ใส่ครั้งเดียวต่อชุด |
| ขอบเขตของ signer | signer ไม่ตีความ PDF รับเฉพาะ "ไบต์ตาม /ByteRange" + key สำรอง แล้วคืน CMS (`POST /signatures/cms`) — การเตรียม PDF/ฝังลายมือชื่ออยู่ที่ API/worker |
| ประทับเวลา | **MSU TSA `https://tsa.msu.ac.th/tsa`** (RFC 3161) ทุกลายมือชื่อ เก็บเป็น `signatureTimeStampToken` — TSA ล่มหรือตอบผิด = ไฟล์นั้นล้มเหลว (ไม่ออกไฟล์ที่ไม่มีเวลา) ใบของ TSA ออกโดย CA ของมหาวิทยาลัยใต้ root ของ TUC ผู้ที่ติดตั้ง root จาก `/root-ca` จึงเชื่อถือได้ |
| ล็อกเอกสาร | certification signature + DocMDP `P=1` (Acrobat แสดง "Certified" แก้ไขใด ๆ แล้วลายมือชื่อไม่ผ่าน) |
| ภาพลายเซ็น | อัปโหลด PNG หรือวาดบนจอ ตั้งครั้งเดียว เก็บจนผู้ใช้เปลี่ยน/ลบหรือลบบัญชี (ยืนยัน 2026-10-25) + บรรทัด "ลงนามดิจิทัลโดย <display_name>" และ "25 ต.ค. 2569 14:30 น." (พ.ศ. เวลาไทย ไม่มีข้อความอื่น) ใต้ภาพเป็นค่าเริ่มต้น (ปิดได้ ระบบสร้างจากฐานข้อมูล ผู้ใช้แก้ข้อความไม่ได้) ฟอนต์ Sarabun ฝังทั้งไฟล์ (subset ของ pdf-lib ทำ glyph ไทยหายได้) — ยังไม่ตั้งภาพ = แสดงข้อความอย่างเดียวได้ |
| ตำแหน่ง | ลากวาง + ย่อขยายบน preview (pdf.js) เก็บเป็นสัดส่วนของหน้าที่แสดงผล (CropBox + /Rotate) ใช้ตำแหน่งเดียวกับทุกไฟล์ในชุด — เริ่มต้นมุมขวาล่างของหน้าแรก (ยืนยัน 2026-10-25) |
| ชุด ZIP | ≤ 100 PDF, ไฟล์ละ ≤ 20 MB, รวมหลังแตก ≤ 500 MB, อัตราบีบอัด ≤ 100 เท่า — worker อ่านจาก storage ทีละช่วง (HTTP Range) ตรวจ central directory ก่อนแตก, ข้าม (แสดงในรายการ) path แปลก/ZIP ซ้อน/ไม่ใช่ PDF/ชื่อซ้ำ, ปฏิเสธทั้ง ZIP เมื่อเข้าข่ายอันตราย (ZIP bomb, เกินจำนวน/ขนาด), ชื่อไทย TIS-620 (ZIP จาก Windows) ถอดถูก — ตัวอย่างสำหรับวางลายเซ็น = PDF ไฟล์แรกใน ZIP อ่านบนเครื่องผู้ใช้ (`fflate`), ลองใหม่ = ใส่ PIN อีกครั้ง เฉพาะไฟล์ที่ล้มเหลวชั่วคราว, ดาวน์โหลดรวม = API สร้าง ZIP ส่งตรง ไม่เก็บซ้ำ (ยืนยัน 2026-10-25) |
| เก็บไฟล์ | Garage (VM เดียวกับระบบ, single node, **ไม่ backup**) 7 วันแล้วลบอัตโนมัติ เก็บถาวรเฉพาะประวัติ (SHA-256, เวลา, ใบรับรอง) — PDPA |
| หลายผู้ลงนาม | ระยะ D4a: ไฟล์ที่มีลายมือชื่ออยู่แล้วเขียนต่อท้ายไฟล์ (incremental update, `pdf-signing/incremental.ts`) ไบต์เดิมไม่เปลี่ยน — ไฟล์ที่ยังไม่มีลายมือชื่อคงเขียนทั้งไฟล์ใหม่ (ยืนยัน 2026-10-26) · ปฏิเสธ: ล็อกไว้ P=1 (`DOCUMENT_LOCKED`), ล็อกไฟล์ที่มีลายมือชื่อแล้ว (`LOCK_NOT_FIRST`), ฉบับแรกที่ xref แบบตารางหลายช่วง เช่น ไฟล์จากโปรแกรมที่เขียน PDF ใหม่โดยไม่เรียงเลข object (รวมระบบนี้ก่อน PR #31) (`COSIGN_UNSAFE_STRUCTURE` — ลงนามเพิ่มแล้ว Acrobat แสดงลายมือชื่อเดิม "altered or corrupted"), เกิน 20 ลายมือชื่อ · ห้ามใช้ `page.node.addAnnot` ของ pdf-lib (ห่อเนื้อหาหน้าด้วย q/Q = Acrobat ถือว่าแก้หน้าหลังลงนาม) · ยืนยันกับ Acrobat Reader 2026.002 แล้ว |
| Permission | `document:sign` — ลงนามเอกสารด้วยใบรับรองของตัวเอง (ยังไม่ผูกกับ role) |
| กฎหมาย | ให้ฝ่ายกฎหมาย/DPO ตรวจเรื่อง server ลงนามด้วย key สำรอง (พ.ร.บ.ธุรกรรมทางอิเล็กทรอนิกส์ ม.26) **ก่อนเปิดใช้จริง** — ไม่บล็อกการพัฒนา |

## สถาปัตยกรรม

```
browser ──(presigned URL)──► Garage (PDF/ZIP ต้นฉบับ, ไฟล์ที่ลงนามแล้ว — ลบ 7 วัน)
   │ ตำแหน่งภาพ + PIN
   ▼
API ── signing_batch + signing_jobs ──► worker (image เดียวกับ API, คนละ process)
                                         ├ preparePdf: ช่องลายมือชื่อ (+ภาพ/ข้อความ) + placeholder /ByteRange /Contents (+DocMDP)
                                         ├ signer.signCms(ไบต์ตาม ByteRange, key สำรอง) ──► signer: ถอด key → openssl cms -sign -cades
                                         ├ requestTimestamp(ค่า signature) ──► MSU TSA (ตรวจ status, hash, nonce)
                                         ├ addSignatureTimestamp + embedSignature
                                         └ ตรวจซ้ำด้วย verifyPdfSignatures → Garage + certificate_audit_logs (sign)
```

โค้ด: `apps/api/src/services/pdf-signing/` (`pdf.ts`, `cms.ts`, `timestamp.ts`, `index.ts` → `signPdf`) และ `apps/signer` `signCms` (`POST /signatures/cms`)

- ตรวจก่อนลงนามทุกไฟล์: ใบยังใช้งานได้ (ไม่หมดอายุ/ไม่ถูกเพิกถอน) บัญชียังเปิดอยู่ — ไม่ผ่าน = งานที่เหลือของชุดล้มเหลวทั้งหมด (signer ปฏิเสธใบที่ไม่อยู่ในช่วงอายุอีกชั้น)
- จองช่อง `/Contents` 32 KB (ใบผู้ลงนาม + สายใบ CA + timestamp token พร้อมใบของ TSA ราว 12–16 KB)
- ประวัติการลงนาม: `certificate_audit_logs` action `sign` หนึ่งแถวต่อไฟล์ เก็บ SHA-256 ไม่เก็บชื่อไฟล์ (log ลบไม่ได้)
- worker (`src/services/signing-worker-service.ts`): หยิบงานด้วย `FOR UPDATE SKIP LOCKED` (รันหลายตัวได้) ตรวจบัญชี/สิทธิ์/ใบ/ไฟล์ใหม่ตอนลงนาม — ล้มเหลวชั่วคราว (TSA/signer/storage ล่ม) ลองใหม่หลัง 30 วินาที และ 2 นาที รวมไม่เกิน 3 ครั้ง, ล้มเหลวถาวร (ไฟล์เสีย/มีลายมือชื่อแล้ว/ใบใช้ไม่ได้) ไม่ลองใหม่, งานค้างสถานะ signing เกิน 10 นาที (worker ตาย) คืนเข้าคิว
- PIN ตรวจที่ API ตอนส่งเข้าคิว (ตรวจไฟล์และใบก่อน PIN) worker ไม่ได้รับ PIN

## ตาราง (ร่าง — สร้างในระยะ D0b–D3)

- `files`: `bucket`, `object_key` (UUID), `original_name`, `mime_type`, `size`, `sha256`, `uploaded_by`, `expires_at`, `deleted_at`
- `signing_pins`: `user_id` PK, `pin_hash` (scrypt + salt), `failed_attempts`, `locked_until`
- `signature_images`: `user_id` PK, `file_id`, `width`, `height` (เปลี่ยนภาพ = ไฟล์เดิมหมดอายุทันที, ไฟล์ที่ผูกแล้วไม่มีวันหมดอายุ)
- `signing_batches`: `user_id`, `certificate_id`, `source` (`single`/`zip`), `appearance` jsonb (visible, page, x, y, w, h เป็นสัดส่วน, showText, imageFileId), `lock_document`, `status` (`extracting` สำหรับ ZIP → `processing` → `completed`/`failed`), `source_file_id` (ZIP), `skipped_entries` jsonb, `error_code` (ทั้งชุด), `extract_*` (คิวแตก ZIP), `expires_at`
- `signing_jobs`: `batch_id`, `source_file_id`, `signed_file_id`, `original_name`, `status` (`pending`/`signing`/`signed`/`failed`), `error_code`, `document_sha256`, `signed_sha256`, `attempts`, `signed_at` + partial index `WHERE status = 'pending'`

## ลำดับการพัฒนา

| ระยะ | งาน | สถานะ |
|---|---|---|
| D0a | เครื่องมือลงนาม: signer `signCms`, `preparePdf`/`embedSignature` (pdf-lib), MSU TSA + ฝัง token, ล็อก DocMDP, สคริปต์ `pnpm --filter api pdf:sign-sample` ทดลองกับ Acrobat | เสร็จ |
| D0b | Garage บน production (`deploy/compose.yml`, `scripts/init-garage.sh`, nginx `/msumyid-files/`) + storage wrapper `src/storage` + ตาราง `files` (`/me/files` ขอ URL อัปโหลด/ยืนยัน/ดาวน์โหลด, job ลบไฟล์หมดอายุ) + PIN ลงนาม (`/me/signing-pin`, ตั้งใหม่เมื่อลืม = login ใหม่ภายใน 10 นาที) | เสร็จ |
| D1 | ลงนามไฟล์เดียวบนเว็บ (มองไม่เห็น) + ล็อก + ดาวน์โหลด + audit ผ่าน worker + ปรับ TSA ที่แนะนำในหน้า `/root-ca` เป็น MSU TSA — หน้า `/sign`, `/sign/pin`, `POST/GET /me/signing-batches`, worker `src/worker.ts` (service `worker` ใน `deploy/compose.yml`) | เสร็จ |
| D2 | ภาพลายเซ็น (อัปโหลด/วาด) + preview pdf.js + ลากวาง/ย่อขยาย + บรรทัดข้อความไทย — `/sign/signature`, `GET/PUT/DELETE /me/signature-image`, `appearance` ใน `POST /me/signing-batches` (บันทึก file_id ของภาพ ณ ตอนส่ง), `pdf-signing/appearance.ts` | เสร็จ |
| D3 | ZIP: อัปโหลด แตกอย่างปลอดภัย คิว ความคืบหน้า ลองใหม่ ดาวน์โหลด ZIP ลบอัตโนมัติ 7 วัน — `signing-zip.ts`, worker แตก ZIP ก่อนลงนาม, `POST /me/signing-batches/:id/retry`, `GET /me/signing-batches/:id/download`, หน้า `/sign/batches/[id]` | เสร็จ |
| D4a | ไฟล์ที่มีลายมือชื่ออยู่แล้ว (incremental, หลายผู้ลงนาม) | เสร็จ |
| D4b | LTV: DSS (สายใบ + CRL) ต่อท้ายหลังลงนาม (`pdf-signing/ltv.ts`, `ltv-service.ts`) — CRL ของ CA ระบบจากตาราง `crls`, CA อื่น (TUC `https://cdp.kku.ac.th/tuc-ca.crl`) ดึงจาก CDP ในใบ (ไม่ตรวจใบ TLS แต่ตรวจลายมือชื่อบน CRL ทุกฉบับ) cache จนหมดอายุ · ได้ไม่ครบ = ลงนามต่อแบบไม่มี LTV · **เอกสารที่ล็อกไม่ใส่ LTV** (Acrobat ถือว่า DSS ที่ต่อท้าย P=1 เป็นการแก้ไข แม้มี ESIC/VRI — ทดสอบ 2026-10-26, เลือกทาง ก.) · `signing_jobs.ltv_status` แสดงในผล · ตัวตรวจ `/verify` ระบุส่วนต่อท้ายที่เป็น LTV ล้วน (`addedAfter = ltv`) และตัดสินเอกสารล็อกที่ถูกต่อท้ายว่าไม่ถูกต้องแบบ Acrobat · Acrobat Reader 2026.002 ขึ้น "Signature is LTV enabled" | เสร็จ |

Dependency (อนุมัติ 2026-10-25): api `pdf-lib`, `@pdf-lib/fontkit`, `yauzl`, `yazl`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (+ `@signpdf/placeholder-plain` ถ้าจำเป็นใน D4) · web `pdfjs-dist` · ฟอนต์ Sarabun (OFL) — ติดตั้งตามระยะที่ใช้
