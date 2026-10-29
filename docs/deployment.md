# การ deploy ระบบขึ้น production

คู่มือ deploy MSU Digital ID บน VM (Ubuntu + Docker + nginx) ที่ `https://did.msu.ac.th`
ไฟล์ที่ใช้จริงอยู่ใน `deploy/`, `apps/*/Dockerfile` และ `.github/workflows/`

> ทดสอบแบบจำลองบนเครื่อง dev แล้ว (registry จำลอง + nginx + CA ปลอม): deploy ครั้งแรก, login ผ่าน `/api` (path ของ cookie), ขอ/ดาวน์โหลดซ้ำ/เพิกถอนใบรับรอง, CRL อัปเดต, rollback อัตโนมัติ, `rollback.sh`, backup + restore, `recover-env.sh`
> ยังไม่ได้ทดสอบ: login กับ Google จริง, GitHub Actions จริง, สิทธิ์ไฟล์ 600 บน Linux, Cloudflare

---

## 1. ภาพรวมสถาปัตยกรรม

```
                         ผู้ใช้ (HTTPS 443) → https://did.msu.ac.th
                                    │
                 ┌──────────────────┴───────────────────┐
                 │ Cloudflare (proxy + WAF ของมหาวิทยาลัย) │  ดูแลโดยงานเครือข่าย — หัวข้อ 12
                 └──────────────────┬───────────────────┘
                 ┌──────────────────┴───────────────────┐
                 │ nginx บน host (ใบรับรอง *.msu.ac.th)     │
                 └──────┬──────────────────────┬────────┘
                     /  │               /api/  │ (ตัด /api ออก)
                        ▼                      ▼
                 ┌────────────┐  API_URL ┌────────────┐  SIGNER_URL  ┌────────────┐
                 │ web :3000  │─────────▶│ api :4000  │─────────────▶│ signer     │
                 │ Next.js    │          │ Express    │  network     │ :4020      │
                 └────────────┘          └─────┬──────┘  signer      │ OpenSSL    │
                  127.0.0.1 เท่านั้น        127.0.0.1    (internal)   │ CA key, KEK│
                                               │ network db          └────────────┘
                                               ▼ (internal)          ไม่มี port ออก host
                                         ┌────────────┐              ออกอินเทอร์เน็ตไม่ได้
                                         │ postgres   │
                                         └────────────┘ ไม่มี port ออก host
       docker compose project `msumyid-prod` ที่ /opt/msumyid
```

| ทาง | ไปที่ | หมายเหตุ |
|---|---|---|
| `/` | web | รวมหน้า public `/login`, `/root-ca` |
| `/api/*` | api | nginx ตัด `/api` ออก: `/api/auth/me` → `/auth/me` และใส่ `Cache-Control: no-store` |
| `/api/crl/msu-ca.crl` | api | CRL สาธารณะ ให้ `cdp.msu.ac.th` ใช้ cron ดึง (หัวข้อ 10) |

## 2. การตัดสินใจหลัก (ยืนยัน 2026-10-14)

| เรื่อง | ที่เลือก | เหตุผล |
|---|---|---|
| โดเมน | `did.msu.ac.th` โดเมนเดียว (web `/`, API `/api`) | cookie แบบ host-only ส่งถึงทั้ง web และ API, ใช้ใบ `*.msu.ac.th` ได้ |
| Garage (S3) | **ยังไม่ขึ้น production** | โค้ดยังไม่ใช้ storage — เพิ่มเมื่อมีฟีเจอร์อัปโหลด/ลงนามเอกสาร |
| signer | VM เดียวกัน, network `internal` ไม่มี port ออก host | มีแค่ api เรียกได้; แยก VM ปลอดภัยกว่าแต่ต้องดูแลเพิ่มอีกเครื่อง |
| secret ของ signer | Docker secret (`secrets/`) + key ของ CA mount `:ro` (`ca/`) | ค่าจริงไม่อยู่ใน env ของ container (`docker inspect` ไม่เห็น) |
| KEK สำรอง | นอก VM แยกจาก backup ฐานข้อมูล (password manager ของผู้ดูแล 2 คน) | ฐานข้อมูลมี key ผู้ใช้ที่เข้ารหัสด้วย KEK — อยู่ชุดเดียวกัน = ถอดได้ทุกคน |
| การ build | GitHub Actions → GHCR แท็ก `sha-<commit 7 ตัว>` | VM ไม่ต้องมี Node/pnpm; rollback = เปลี่ยนแท็ก |
| การสั่ง deploy | บน VM: `./scripts/deploy.sh sha-xxxxxxx` (pull-based) | ไม่ต้องเปิด SSH ให้ GitHub |
| Migration | container ครั้งเดียวจาก image api เวอร์ชันใหม่ **ก่อน** สลับ | migrate ล้ม → เวอร์ชันเดิมยังทำงาน |
| ชื่อบน VM | `/opt/msumyid`, compose project `msumyid-prod` | ไม่ชนกับ dev (`msumyid`) |
| ปลายทาง backup นอก VM | **ยังไม่กำหนด** | สคริปต์รองรับแล้ว ตั้ง `BACKUP_REMOTE` |

## 3. การแก้โค้ดเพื่อรองรับ production

| เรื่อง | ไฟล์ | รายละเอียด |
|---|---|---|
| path ของ OAuth cookie | `apps/api/src/config/index.ts` (`oauthCookiePath`), `middlewares/auth.ts` | เดิมฮาร์ดโค้ด `/auth/google` → login ล้มเมื่อ API อยู่ใต้ `/api`; ตอนนี้คำนวณจาก `GOOGLE_REDIRECT_URI` (route ใน Express ไม่เปลี่ยน) |
| `trust proxy` | `apps/api/src/app.ts`, env `TRUST_PROXY` | หลัง nginx = `1` ไม่เช่นนั้น rate limit ของ `/auth/*` นับทุกคนเป็น IP เดียว; ห้าม `true` |
| คอมไพล์ api/signer | `apps/{api,signer}/tsconfig.build.json` | `dist/src/server.js`, `dist/scripts/*.js` (seed, cert:import) — ไม่ใช้ `tsx` ใน production |
| Next.js standalone | `apps/web/next.config.ts` | รันด้วย `node apps/web/server.js` |
| env ของ web | `apps/web/src/lib/config.ts`, `src/instrumentation.ts` | อ่าน env ตอนใช้งาน (build ได้โดยไม่มี env) และตรวจครบตอนเริ่ม server ขาด = exit 1 |
| secret จากไฟล์ | `apps/{api,signer}/src/config/secret-files.ts` | `NAME_FILE=/run/secrets/x` แทน `NAME` (signer: `SIGNER_TOKEN`, `CA_KEY_PASSPHRASE`, `ESCROW_KEK`; api: `SIGNER_TOKEN`) |
| migration ใน image | `apps/api/package.json` | `node-pg-migrate` อยู่ใน dependencies |

## 4. ไฟล์ใน repo

```
apps/api/Dockerfile           node:22.17.0-alpine3.22, user node, มี migrations ในตัว
apps/signer/Dockerfile        + OpenSSL, มีเฉพาะ ca/*.cert.pem (ใบสาธารณะ) — key mount ตอนรัน
apps/web/Dockerfile           standalone — ต้องระบุ --build-arg NEXT_PUBLIC_API_URL
.dockerignore                 กัน .env / key / .dev-ca (และ image สุดท้ายคัดลอกแบบ allowlist)
.github/workflows/ci.yml      ทุก PR: lint, typecheck, test (PostgreSQL จริง + OpenSSL)
.github/workflows/release.yml merge เข้า main: CI ซ้ำ → build + push 3 image ไป GHCR
deploy/                       ← คัดลอกทั้งโฟลเดอร์ไปเป็น /opt/msumyid บน VM
  compose.yml                 postgres, signer, api, web, migrate (profile tools)
  nginx/msumyid.conf          site ของ nginx บน host
  env/*.env.example           แม่แบบ: deploy (→ .env), api, web, signer, postgres
  scripts/deploy.sh           ตรวจไฟล์ → backup → pull → migrate → สลับ → รอ healthy (ไม่ผ่าน = กลับเวอร์ชันเดิมอัตโนมัติ)
  scripts/rollback.sh         กลับไปเวอร์ชันก่อนหน้า (ไม่ย้อน migration)
  scripts/backup.sh           pg_dump + env (ไม่รวม secrets/ และ ca/) + ลบของเก่า + rsync ออกนอก VM
  scripts/archive-logs.sh     เก็บ log ของ container รายวันลง logs/<วันที่>/ + ลบที่เก่ากว่า LOG_KEEP_DAYS (90)
  scripts/init-secrets.sh     สร้าง signer_token / escrow_kek ครั้งแรก (ไม่สร้างทับ)
  scripts/recover-env.sh      กู้ env/*.env ที่หายจาก container ที่ยังอยู่
  scripts/update-cloudflare-realip.sh  ช่วง IP ของ Cloudflare ให้ nginx (nginx -t ไม่ผ่าน = คืนไฟล์เดิม)
  scripts/init-garage.sh      เปิด Garage + layout + key/bucket + เขียน secrets/s3_* (รันซ้ำได้)
  garage/garage.toml          config ของ Garage (single node, secret อ่านจาก Docker secret)
  cdp/                        ติดตั้งบนเครื่อง cdp.msu.ac.th (ไม่ใช้บน VM): update-crl.sh + systemd timer ดึง CRL (หัวข้อ 10)
```

โครงบน VM (ไฟล์ที่ไม่อยู่ใน git ระบุไว้ใน `deploy/.gitignore`):

```
/opt/msumyid/
  .env                  APP_TAG, IMAGE_PREFIX, APP_UID/GID, port, backup
  env/*.env             api, web, signer, postgres          (600)
  secrets/              signer_token, ca_key_passphrase, escrow_kek   (700/600) — ไม่อยู่ใน backup
  ca/univ-ca.key.pem    key ของ Intermediate CA (เข้ารหัสด้วย passphrase)  (600) — ไม่อยู่ใน backup
  backups/  deployed.log
```

## 5. เตรียม VM ครั้งแรก (ทำครั้งเดียว)

**5.0 สเปก VM** — ใช้กับระบบนี้ระบบเดียว (VM ถือ key ของ Intermediate CA และ KEK — ระบบอื่นบนเครื่องเดียวกันถูกเจาะ = key รั่ว)
- Ubuntu 24.04 LTS (ห้ามใช้รุ่นที่หมดระยะ support), 2 vCPU, RAM 4 GB, disk 40 GB ขึ้นไป
- Docker Engine + Compose v2 จาก repo ของ Docker (`docker compose version` ต้องเป็น v2.20 ขึ้นไป — `docker-compose` v1 ของ Ubuntu ใช้ไม่ได้)
- nginx 1.18 ขึ้นไป (จาก Ubuntu 24.04 ได้ 1.24)

**5.1 ฝั่ง GitHub**
1. merge PR ที่มีไฟล์ชุดนี้เข้า `main` → workflow **Release** build image ครั้งแรก (ดูแท็กในหน้า Actions → Summary)
2. (ถ้าต้องเปลี่ยน URL ของ API) Settings → Secrets and variables → Actions → Variables: `NEXT_PUBLIC_API_URL`
3. สร้าง Personal Access Token (classic) สิทธิ์ `read:packages` เท่านั้น ให้ VM ดึง image (GHCR เป็น private ตามค่าเริ่มต้น)

**5.2 ฝั่ง Google Cloud Console** (OAuth client ของ production แยกจาก dev)
- Authorized redirect URI: `https://did.msu.ac.th/api/auth/google/callback`
- Authorized JavaScript origin: `https://did.msu.ac.th`

**5.3 ฝั่ง VM**
```bash
sudo adduser --disabled-password --gecos "" deploy && sudo usermod -aG docker deploy
sudo mkdir -p /opt/msumyid && sudo chown deploy:deploy /opt/msumyid && sudo chmod 750 /opt/msumyid
sudo -iu deploy                      # deploy ไม่มีรหัสผ่านและไม่มี sudo — เข้าทางนี้เท่านั้น
git clone https://github.com/tanasats/msumyid2026.git ~/msumyid2026
cp -r ~/msumyid2026/deploy/. /opt/msumyid/
# ⚠ ทุกไฟล์ใน /opt/msumyid ต้องเป็นของผู้ใช้ deploy (ห้ามสร้างด้วย sudo) ถ้าเผลอ: sudo chown -R deploy:deploy /opt/msumyid
cd /opt/msumyid
cp env/deploy.env.example .env
for f in api web signer postgres; do cp env/$f.env.example env/$f.env; done
chmod 600 .env env/*.env
sed -i "s/^APP_UID=.*/APP_UID=$(id -u)/; s/^APP_GID=.*/APP_GID=$(id -g)/" .env
```
กรอกค่าในไฟล์ env (**รูปแบบ `KEY=value` ล้วน** — docker ไม่ตัดคอมเมนต์ท้ายบรรทัดหรือเครื่องหมายคำพูด):
- `env/postgres.env`: `POSTGRES_PASSWORD` สุ่มด้วย `openssl rand -hex 32` และใส่รหัสเดียวกันใน `DATABASE_URL` ของ `env/api.env`
- `env/api.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `INITIAL_SUPER_ADMIN_EMAIL`
- ค่าอื่นตั้งไว้สำหรับ `did.msu.ac.th` แล้ว — ไม่ต้องแก้ถ้าไม่เปลี่ยนโดเมน

**5.4 CA และ secret ของ signer** — ดูหัวข้อ 9 ก่อนทำ
```bash
./scripts/init-secrets.sh            # สร้าง secrets/signer_token และ secrets/escrow_kek
# ⚠ สำรอง escrow_kek นอก VM ทันที (หัวข้อ 9)
read -rs P && printf '%s' "$P" > secrets/ca_key_passphrase && unset P   # passphrase ของ key CA
# คัดลอก univ-ca.key.pem มาที่ ca/ (scp จากเครื่องที่เก็บ key) แล้ว
chmod 600 ca/univ-ca.key.pem secrets/*
```

**5.4.1 ที่เก็บไฟล์ (Garage)** — ใช้กับการลงนามเอกสาร (`docs/design/document-signing.md`) single node บน VM เดียวกัน **ไม่ backup** (ไฟล์เก็บ 7 วันแล้วลบอัตโนมัติ — ตัดสินใจ 2026-10-25)
```bash
./scripts/init-secrets.sh            # (ถ้ายังไม่ได้รันหลังอัปเดต) สร้าง secrets/garage_rpc_secret, secrets/garage_admin_token
./scripts/init-garage.sh             # เปิด garage, กำหนด layout (GARAGE_CAPACITY ค่าเริ่มต้น 20G), สร้าง key + bucket (S3_BUCKET)
                                     # แล้วเขียน secrets/s3_access_key, secrets/s3_secret_key — รันซ้ำได้
```
- browser อัปโหลด/ดาวน์โหลดตรงกับ Garage ด้วย presigned URL ผ่าน nginx: `https://did.msu.ac.th/<S3_BUCKET>/...` → `127.0.0.1:GARAGE_S3_PORT` (location `/msumyid-files/` ใน `msumyid.conf` ชื่อต้องตรงกับ `S3_BUCKET`)
- origin เดียวกับหน้าเว็บ จึงไม่ต้องตั้ง CORS ของ bucket บน production (`storage:cors` ใช้กับ dev)
- **Cloudflare จำกัดขนาด request** ตามแผนที่ใช้ (Free/Pro 100 MB) — ZIP ที่ใหญ่กว่านี้ต้องอัปโหลดแบบ multipart (ระยะ D3 ของการลงนามเอกสาร)

**5.5 deploy ครั้งแรก**
```bash
echo '<PAT read:packages>' | docker login ghcr.io -u <github-user> --password-stdin
./scripts/deploy.sh sha-xxxxxxx       # สร้าง postgres + migrate ทั้งหมด + เปิด signer/api/web
```
signer ตรวจตอนเริ่มว่า key ตรงกับใบ Intermediate และสายใบถึง root ถูกต้อง ไม่ผ่าน = ไม่ healthy และ deploy.sh จะหยุด (ดู `docker compose logs signer`)

**5.6 nginx** — ในฐานะผู้ใช้ที่มี sudo (ไม่ใช่ `deploy`) เพราะต้องแก้ไฟล์ของระบบ

ใบรับรอง TLS ของมหาวิทยาลัย (`*.msu.ac.th` ออกโดย GeoTrust TLS RSA CA G1) มาเป็นใบเดียว ต้องต่อ intermediate เอง:
```bash
# ไฟล์ intermediate จาก GeoTrust เป็น DER — OpenSSL 3 อ่าน DER ได้เอง จึงต้องสั่งแปลงเป็น PEM ตรง ๆ ก่อนต่อไฟล์
curl -fsS -o inter.crt http://cacerts.geotrust.com/GeoTrustTLSRSACAG1.crt   # URL จาก "CA Issuers" ในใบ
openssl x509 -in inter.crt -out inter.pem
openssl verify -untrusted inter.pem msu.crt                                  # ต้องได้ msu.crt: OK
{ cat msu.crt; echo; cat inter.pem; } | sed 's/\r$//; /^$/d' > fullchain.pem
grep -c 'BEGIN CERTIFICATE' fullchain.pem                                    # ต้องได้ 2
sudo mkdir -p /etc/ssl/msu
sudo install -o root -g root -m 644 fullchain.pem /etc/ssl/msu/fullchain.pem
sudo install -o root -g root -m 600 msu.key       /etc/ssl/msu/privkey.pem  # key ต้องไม่มีรหัสผ่าน
```
ติดตั้ง site:
```bash
# /opt/msumyid เป็นของ deploy (750) ผู้ใช้อื่นอ่านได้ผ่าน sudo เท่านั้น
sudo bash /opt/msumyid/scripts/update-cloudflare-realip.sh   # ติดตั้ง /etc/nginx/snippets/cloudflare-realip.conf (ต้องมีก่อน)
sudo cp /opt/msumyid/nginx/msumyid.conf /etc/nginx/sites-available/msumyid.conf
sudo ln -s /etc/nginx/sites-available/msumyid.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
curl -s --resolve did.msu.ac.th:443:127.0.0.1 https://did.msu.ac.th/api/health   # ทดสอบก่อนมี DNS/Cloudflare
```
**ระยะเก็บ log ของ nginx = 90 วัน** (ประกาศความเป็นส่วนตัว + พ.ร.บ.คอมพิวเตอร์ ม.26 — `docs/design/pdpa.md`) ค่าเริ่มต้นของ Ubuntu เก็บ 14 วัน ให้แก้ `/etc/logrotate.d/nginx` เป็น `daily` + `rotate 90` แล้วตรวจด้วย `sudo logrotate -d /etc/logrotate.d/nginx`

ถ้าเปลี่ยน `WEB_PORT`/`API_PORT`/`GARAGE_S3_PORT` ใน `.env` ต้องแก้ upstream / location `/msumyid-files/` ใน `msumyid.conf` ให้ตรง

**ใบ TLS `*.msu.ac.th` หมดอายุ 2027-03-05** — ต่ออายุล่วงหน้าอย่างน้อย 1 เดือน แล้วทำขั้นตอนข้างบนซ้ำ (เฉพาะส่วนใบรับรอง) และ `sudo systemctl reload nginx`

**5.7 super_admin คนแรก**: เจ้าของ `INITIAL_SUPER_ADMIN_EMAIL` login ด้วย Google 1 ครั้ง แล้ว
```bash
docker compose run --rm api node dist/scripts/seed-super-admin.js
```

**5.8 ย้ายใบรับรองจากระบบเดิม** — หัวข้อ 11 (ก่อนตั้ง timer ดึง CRL บน cdp)

**5.9 สำรองข้อมูลอัตโนมัติ** (`crontab -e` ของผู้ใช้ deploy)
```
0 2 * * * /opt/msumyid/scripts/backup.sh daily >> /opt/msumyid/backups/cron.log 2>&1
15 0 * * * /opt/msumyid/scripts/archive-logs.sh >> /opt/msumyid/logs/cron.log 2>&1
```
`archive-logs.sh` ต้องมีโฟลเดอร์ `logs/` ก่อน (`mkdir -m 700 /opt/msumyid/logs`) — log ของ Docker หายเมื่อ container ถูกสร้างใหม่ `deploy.sh`/`rollback.sh` จึงเก็บ log ของวันนั้นไว้ก่อนสลับเวอร์ชันทุกครั้ง (`logs/<วันที่>/<service>-<เวลา>.log.gz`) — อย่าสั่ง `docker compose up`/`down` กับ api/web/worker เองโดยไม่เก็บ log ก่อน

**5.10 Firewall**: เปิดเฉพาะ 22 (จำกัด IP ถ้าทำได้), 80, 443

## 6. Workflow การ deploy แต่ละครั้ง

```
 developer           GitHub                                   VM (/opt/msumyid)
 ─────────           ──────                                   ─────────────────
 feature/* ──PR──▶   CI: lint + typecheck + test
          merge ──▶  Release: CI ซ้ำ → build api/web/signer
                     → ghcr.io/tanasats/msumyid2026-{api,web,signer}:sha-abc1234
                                                              ./scripts/deploy.sh sha-abc1234
                                                               0. ตรวจไฟล์ env/secret/key ครบ
                                                               1. backup (pre-sha-abc1234)
                                                               2. pull image    ── ล้ม → หยุด ไม่เปลี่ยนอะไร
                                                               3. migrate       ── ล้ม → หยุด เวอร์ชันเดิมยังทำงาน
                                                               4. สลับ signer/api/web + รอ healthy
                                                                  └ ไม่ผ่าน → กลับเวอร์ชันเดิมอัตโนมัติ
                                                               5. บันทึกลง deployed.log
```

1. merge PR เข้า `main` → รอ **Release** เสร็จ → ดูแท็กใน Summary
2. `ssh deploy@<vm>` → `cd /opt/msumyid && ./scripts/deploy.sh sha-abc1234`
3. ตรวจด้วยตา: หน้าแรก, login ด้วย Google, รายการใบรับรอง, `/root-ca` และดาวน์โหลด `.cer`, `curl -s https://did.msu.ac.th/api/health`
4. ถ้า PR นั้นแก้ไฟล์ใน `deploy/` (compose, nginx, สคริปต์, env ตัวอย่าง) ต้องคัดลอกไฟล์ที่เปลี่ยนไปที่ VM ด้วย (ห้ามทับ `.env`, `env/*.env`, `secrets/`, `ca/`)

downtime ระหว่างสลับ container ไม่กี่วินาที

**อัปเดตเครื่องที่ deploy ไว้ก่อนมี Garage (ครั้งเดียว):**
1. คัดลอก `deploy/compose.yml`, `deploy/garage/`, `deploy/scripts/`, `deploy/nginx/msumyid.conf` ไปที่ `/opt/msumyid` (ห้ามทับ `.env`, `env/*.env`, `secrets/`, `ca/`)
2. เพิ่มใน `.env`: `GARAGE_S3_PORT=3900` · เพิ่มใน `env/api.env`: `S3_PUBLIC_ENDPOINT=https://did.msu.ac.th`, `S3_REGION=garage`, `S3_BUCKET=msumyid-files`, `S3_FORCE_PATH_STYLE=true` (ดู `env/api.env.example`)
3. `./scripts/init-secrets.sh && ./scripts/init-garage.sh` (หัวข้อ 5.4.1)
4. nginx: `sudo cp /opt/msumyid/nginx/msumyid.conf /etc/nginx/sites-available/msumyid.conf && sudo nginx -t && sudo systemctl reload nginx`
5. `./scripts/deploy.sh sha-<commit>` ตามปกติ (deploy.sh ตรวจว่ามี secret ของ Garage ครบก่อน)

**เพิ่ม worker ลงนามเอกสาร (D1, ครั้งเดียว):** คัดลอก `deploy/compose.yml` และ `deploy/scripts/` ไปที่ `/opt/msumyid` ก่อน deploy เวอร์ชันที่มี worker — `deploy.sh` สลับ `worker` (image เดียวกับ api, ไม่เปิด port, healthcheck จากไฟล์ heartbeat) พร้อม signer/api/web ส่วน rollback ไปเวอร์ชันก่อน D1 จะหยุด worker ให้เอง (งานที่รออยู่ค้างในคิว ไม่หาย) — ตรวจ: `docker compose ps worker` ต้อง healthy และ `docker compose logs --tail 20 worker`

**ค่าตั้งที่ย้ายจาก env ไปฐานข้อมูล (2026-10-24):** `ALLOWED_EMAIL_DOMAINS`, `SESSION_TTL_DAYS`, `CRL_VALIDITY_DAYS`, `CRL_REISSUE_HOURS` อยู่ในตาราง `system_settings` แก้ที่ `/admin/settings` (super_admin) มีผลทันทีไม่ต้อง restart — migration ตั้งค่าเริ่มต้น `msu.ac.th` / 7 / 7 / 24 ถ้า `env/api.env` บน VM ตั้งค่าอื่นไว้ ให้แก้ในหน้าตั้งค่าหลัง deploy แล้วลบ 4 บรรทัดนี้ออกจาก `env/api.env` (API ไม่อ่านแล้ว)

## 7. Rollback

- `./scripts/rollback.sh` → กลับไปแท็กก่อนหน้าใน `deployed.log` (หรือระบุ: `./scripts/rollback.sh sha-xxxx`)
- rollback **ไม่ย้อน migration** — migration ของโปรเจกต์นี้เพิ่มตาราง/คอลัมน์เป็นหลัก โค้ดเวอร์ชันเก่ามักทำงานกับ schema ใหม่ได้
- ต้องย้อน schema จริง → restore จาก backup `pre-<แท็ก>` (หัวข้อ 8) — ไม่ใช้ `migrate down` บน production
- หลักการเขียน migration: ลบ/เปลี่ยนชื่อคอลัมน์ให้แบ่ง 2 รอบ deploy (รอบแรกเลิกใช้ในโค้ด รอบถัดไปจึงลบ)

## 8. สำรองและกู้คืนข้อมูล

`scripts/backup.sh` สร้าง `backups/<เวลา>-<ป้าย>/`
- `db.dump` — `pg_dump -Fc` (มีใบรับรอง, CRL และ **key ผู้ใช้ที่เข้ารหัสด้วย KEK**)
- `env.tgz` — `.env` และ `env/*.env` (มีรหัสผ่าน DB และ Google client secret — ปลายทางต้องจำกัดสิทธิ์)
- **ไม่มี** `secrets/` และ `ca/` โดยตั้งใจ — เก็บแยกตามหัวข้อ 9

ลบชุดที่เก่ากว่า `BACKUP_KEEP_DAYS` (14 วัน) และถ้ากำหนด `BACKUP_REMOTE` จะ `rsync` ออกนอก VM
**ยังไม่กำหนดปลายทาง — backup อยู่บน VM เดียวกับระบบ (สคริปต์เตือนทุกครั้ง) ควรกำหนดก่อนเปิดใช้จริง**
ตัวอย่าง: `BACKUP_REMOTE=backup@nas.msu.ac.th:/backups/msumyid` (SSH key ของผู้ใช้ deploy เข้าได้โดยไม่ถามรหัสผ่าน)

**ไฟล์ env หาย/ถูกลบ** — สคริปต์ทุกตัวตรวจก่อนเริ่ม ถ้าหายจะหยุดโดยไม่แตะระบบ
```bash
# ห้ามสั่ง deploy / rollback / docker compose up / down ก่อนกู้เสร็จ
cd /opt/msumyid
./scripts/recover-env.sh                               # วิธีที่ 1: จาก container ที่ยังอยู่ (สร้างเฉพาะไฟล์ที่หาย)
tar xzf backups/<ชุดล่าสุด>/env.tgz -C /opt/msumyid     # วิธีที่ 2: จาก backup
docker compose config -q && ./scripts/backup.sh after-recover
```
`secrets/` หรือ `ca/` หาย → กู้จากสำเนานอก VM (หัวข้อ 9) เท่านั้น

**กู้คืนฐานข้อมูล**
```bash
cd /opt/msumyid
docker compose stop api web
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < backups/<ชุด>/db.dump
docker compose up -d --wait api web
```
key สำรองใน `db.dump` ใช้ได้เฉพาะกับ KEK ตัวเดียวกับที่เข้ารหัส (`ESCROW_KEK_ID`) — กู้บนเครื่องใหม่ต้องมี `secrets/escrow_kek` เดิม

ทดลองกู้คืนลงเครื่องทดสอบอย่างน้อยเดือนละครั้ง

## 9. CA และ signer

| ของ | อยู่ที่ VM | สำเนานอก VM | หาย = |
|---|---|---|---|
| `ca/univ-ca.key.pem` | mount `:ro` เข้า signer | ที่เก็บ key ของ CA เดิม (offline) | ออกใบใหม่/CRL ไม่ได้ |
| `secrets/ca_key_passphrase` | Docker secret | password manager ผู้ดูแล CA | เหมือนกัน |
| `secrets/escrow_kek` | Docker secret | **password manager ของผู้ดูแล 2 คน** แยกจาก backup | กู้ key สำรองของผู้ใช้ไม่ได้ทั้งหมด (ดาวน์โหลด .p12 ซ้ำไม่ได้) |
| `secrets/signer_token` | Docker secret (signer + api) | ไม่ต้อง | สร้างใหม่ได้: ลบไฟล์ → `init-secrets.sh` → `docker compose up -d --force-recreate signer api` |

- **ห้าม** เก็บ `escrow_kek` ไว้ใน `backups/`, `env.tgz` หรือปลายทาง `BACKUP_REMOTE` เดียวกับ `db.dump`
- **หมุน KEK** (เมื่อสงสัยว่ารั่ว): ยังไม่มีเครื่องมือ re-wrap key เดิม — `ESCROW_KEK_ID` เก็บคู่กับ key สำรองทุกก้อนไว้รองรับแล้ว ต้องพัฒนาสคริปต์ก่อนใช้งานจริง
- **ใบ root ของ TUC หมดอายุ 2030-03-25** — ต่ออายุแล้วแก้ `apps/signer/ca/root.cert.pem`, `apps/web/src/lib/root-ca.ts` และ `apps/api/src/services/signature-verification/university-ca.ts` (test ตรวจว่าตรงกัน) แล้ว deploy ใหม่ (`docs/design/certificates.md`)
- ใบของ CA (`univ-ca.cert.pem`, `root.cert.pem`) อยู่ใน image ของ signer — แก้ใบ = build image ใหม่

## 10. CRL

- ใบรับรองทุกใบฝัง `CRL_DISTRIBUTION_URL=https://cdp.msu.ac.th/msu-ca.crl` (ใบเดิมใช้ค่านี้ เปลี่ยนไม่ได้)
- ระบบออก CRL ใหม่ทันทีเมื่อเพิกถอน และตามรอบที่ตั้งในหน้า `/admin/settings` (ค่าเริ่มต้น 24 ชั่วโมง) เผยแพร่ที่ `https://did.msu.ac.th/api/crl/msu-ca.crl`
- บน `cdp.msu.ac.th` ตั้ง cron ดึงทุก 5–15 นาที เช่น
  ```
  */10 * * * * curl -fsS --max-time 30 -o /var/www/cdp/msu-ca.crl.tmp https://did.msu.ac.th/api/crl/msu-ca.crl && openssl crl -in /var/www/cdp/msu-ca.crl.tmp -noout && mv /var/www/cdp/msu-ca.crl.tmp /var/www/cdp/msu-ca.crl
  ```
  (ตรวจด้วย `openssl crl` ก่อนแทนที่ — ได้หน้า error มา = ไม่ทับฉบับเดิม; `CRL_PUBLISH_FORMAT=der` ต้องเพิ่ม `-inform DER`)
- **ตั้ง cron หลังนำเข้าใบเดิมเสร็จเท่านั้น** (หัวข้อ 11)
- ระบบออก CRL ใหม่ทันทีเมื่อเพิกถอน และทุก `CRL_REISSUE_HOURS` เผยแพร่ที่ `https://did.msu.ac.th/api/crl/msu-ca.crl`
### อัปเดตไฟล์บน cdp.msu.ac.th (`deploy/cdp/`)

cdp เป็นฝ่ายดึงทุก 10 นาที (ระบบไม่ต้องมีสิทธิ์เขียนเข้า cdp) — did ล่ม = cdp เผยแพร่ฉบับล่าสุดต่อจนครบอายุ CRL
`update-crl.sh` แทนที่ไฟล์เฉพาะเมื่อผ่านทุกข้อ ไม่ผ่าน = คงฉบับเดิม + log `ERROR`:

1. ดาวน์โหลดด้วย HTTPS เท่านั้น (ตรวจใบรับรองเว็บ, จำกัดเวลา/ขนาด)
2. `openssl crl -CAfile ca-chain.pem` ต้อง `verify OK` — ได้หน้า error / ไฟล์เสีย / CA อื่น = ไม่ผ่าน (รับได้ทั้ง PEM และ DER)
3. next update เหลืออย่างน้อย 24 ชั่วโมง (`MIN_REMAINING_HOURS`)
4. เลข CRL มากกว่าฉบับที่เผยแพร่อยู่ (เท่ากัน = ไม่ทำอะไร), ฉบับใหม่ไม่ว่างถ้าฉบับเดิมไม่ว่าง และใบที่เพิกถอนภายใน 30 วันล่าสุด (`RECENT_DAYS`) ยังอยู่ครบ — กัน CRL ว่าง/ฐานข้อมูลที่กู้จาก backup เก่าทับ (ระบบตัดใบที่เพิกถอนแล้วหมดอายุครบ 30 วันออก จำนวนใบจึงลดลงได้ — `RECENT_DAYS` ต้องไม่เกิน `CRL_EXPIRED_RETENTION_DAYS` ของ API)

แทนที่ด้วย `mv` ในโฟลเดอร์เดียวกัน (ไม่มีใครได้ไฟล์ครึ่ง ๆ), เก็บฉบับก่อนหน้าเป็น `msu-ca.crl.prev`, `flock` กันรอบซ้อน, เตือน `WARN` เมื่อฉบับที่เผยแพร่อยู่เหลืออายุไม่ถึง 72 ชั่วโมง (`STALE_WARN_HOURS`) แม้รอบนั้นดึงไม่สำเร็จ

ติดตั้ง (บนเครื่อง cdp — ไม่ใช่ VM ของระบบ):
```bash
# ใบของ CA (ข้อมูลสาธารณะ) จาก apps/signer/ca/
sudo mkdir -p /etc/msu-cdp
cat univ-ca.cert.pem root.cert.pem | sudo tee /etc/msu-cdp/ca-chain.pem >/dev/null
sudo install -m 755 update-crl.sh /usr/local/bin/msu-update-crl
sudo install -m 644 msu-crl.service msu-crl.timer /etc/systemd/system/   # แก้ User= ให้เป็นผู้ที่เขียน /var/www/cdp ได้
# ครั้งแรก: วาง CRL ฉบับปัจจุบันของระบบเดิมไว้ที่ /var/www/cdp/msu-ca.crl ก่อน (ข้อ 4 จะกันฉบับที่รายการน้อยกว่าทับ)
sudo systemctl daemon-reload
sudo systemctl start msu-crl.service && journalctl -t msu-crl -n 5    # ลองรัน 1 ครั้ง
sudo systemctl enable --now msu-crl.timer
```
ไม่มี systemd: `*/10 * * * * /usr/local/bin/msu-update-crl` · ค่าอื่น (`SOURCE_URL`, `TARGET`, `CA_CHAIN`) ตั้งผ่าน env ได้

เว็บเซิร์ฟเวอร์ของ cdp: `Content-Type: application/pkix-crl`, `Cache-Control: max-age=600` (ไม่นานกว่ารอบดึง) และ **ต่ออายุใบรับรอง HTTPS อัตโนมัติ** — URL ในใบทุกใบเป็น `https://` ใบของเว็บหมดอายุ = โปรแกรมตรวจลายเซ็นดึง CRL ไม่ได้

ติดตาม: แจ้งเตือนเมื่อ `journalctl -t msu-crl` มี `ERROR`/`WARN` และตรวจจากภายนอกวันละครั้ง `curl -s https://cdp.msu.ac.th/msu-ca.crl | openssl crl -noout -nextupdate`
เปลี่ยน CA (เช่น ต่ออายุ Intermediate) ต้องอัปเดต `/etc/msu-cdp/ca-chain.pem` บน cdp ด้วย ไม่เช่นนั้นข้อ 2 จะไม่ผ่าน

- **ตั้ง timer หลังนำเข้าใบเดิมเสร็จเท่านั้น** (หัวข้อ 11)

## 11. ย้ายจาก CA เดิม (`openssl ca` บน Ubuntu)

ลำดับตาม `docs/design/certificates.md` หัวข้อ "ลำดับการย้ายระบบ":
1. deploy ตามหัวข้อ 5 (signer ใช้ key ของ Intermediate จริง) — ยัง **ไม่** ตั้ง timer บน cdp
2. หยุดใช้ `openssl ca` บนเครื่องเดิม แล้วคัดลอกโฟลเดอร์ CA (ไม่ต้องมี CA key) มาไว้ชั่วคราว เช่น `/opt/msumyid/legacy-ca` (chmod 700)
3. ทดลองก่อน แล้วค่อยรันจริง
   ```bash
   docker compose run --rm -v /opt/msumyid/legacy-ca:/legacy:ro api \
     node dist/scripts/import-legacy-certificates.js --dir /legacy --passwords /legacy/pkcs12-files.csv --dry-run
   # ตรวจรายงาน แล้วรันซ้ำโดยไม่มี --dry-run
   ```
4. `curl -s https://did.msu.ac.th/api/crl/msu-ca.crl | openssl crl -noout -text` ต้องมีใบที่เพิกถอนเดิมครบ แล้วจึงตั้ง timer บน cdp (หัวข้อ 10)
5. ลบ `/opt/msumyid/legacy-ca` และทำลาย `private/` + `pkcs12-files.csv` บนเครื่องเดิม

## 12. Cloudflare

`did.msu.ac.th` อยู่หลัง Cloudflare ของมหาวิทยาลัย (proxy + WAF) ซึ่ง**งานเครือข่ายเป็นผู้ดูแล**

**IP จริงของผู้ใช้ (realip)** — ไม่ตั้ง = rate limit ของการ login นับผู้ใช้หลายคนเป็น IP เดียว
- `/etc/nginx/snippets/cloudflare-realip.conf` เชื่อ `CF-Connecting-IP` **เฉพาะคำขอจากช่วง IP ของ Cloudflare** → `$remote_addr` = IP จริง → nginx ต่อท้าย `X-Forwarded-For` → API (`TRUST_PROXY=1`) อ่านค่าขวาสุด
- ตรวจและปรับปีละ 1–2 ครั้ง: `./scripts/update-cloudflare-realip.sh`

**WAF Skip rule (ขอจากงานเครือข่าย — host `did.msu.ac.th` ทุกข้อ)**

Managed Rules ตรวจเนื้อไฟล์ไบนารี (PDF/ZIP/PNG) แล้วชนกฎแบบสุ่ม — พบจริง 2026-10-28: อัปโหลด PDF เพื่อลงนามถูกบล็อกด้วย "PHP - Code Injection" (rule `ed1e2fad498d4e53bb0670e32d2e031c`) ทั้งที่ API ออก presigned URL ให้แล้ว

| Path | Method | ข้าม | เหตุผล |
|---|---|---|---|
| `/msumyid-files/` (ขึ้นต้นด้วย) | `PUT`, `GET` | Managed Rules + กฎ Bot Score/Bot Fight | browser อัปโหลด/ดาวน์โหลดตรงกับ Garage: `signing-source/` (PDF/ZIP), `signature-image/` (PNG), `signing-result/` |
| `/api/verify/pdf` | `POST` | Managed Rules | หน้า `/verify` สาธารณะ ส่ง PDF ดิบ ≤20 MB |
| `/api/crl/msu-ca.crl` | `GET` | กฎ Bot Score/Bot Fight/challenge | `cdp.msu.ac.th` ดึงด้วย cron (bot score ต่ำ) — ติด challenge = CRL ไม่ถูกเผยแพร่ (หรือให้ cron ดึงผ่าน IP ภายในแทน) |

```
# กฎที่ 1 — Skip: Managed Rules
(http.host eq "did.msu.ac.th" and starts_with(http.request.uri.path, "/msumyid-files/") and http.request.method in {"PUT" "GET"})
or (http.host eq "did.msu.ac.th" and http.request.uri.path eq "/api/verify/pdf" and http.request.method eq "POST")
# กฎที่ 2 — Skip: Custom rules เรื่อง Bot Score + Bot Fight
(http.host eq "did.msu.ac.th" and starts_with(http.request.uri.path, "/msumyid-files/") and http.request.method in {"PUT" "GET"})
or (http.host eq "did.msu.ac.th" and http.request.uri.path eq "/api/crl/msu-ca.crl" and http.request.method eq "GET")
```

ยกเว้นแล้วยังปลอดภัย: `/msumyid-files/` ใช้ได้เฉพาะ URL ที่ API ลงลายเซ็น (หมดอายุ 10 นาที, ตรวจสิทธิ์/ชนิด/ขนาดก่อนออก URL — Garage ปฏิเสธลายเซ็นผิดเอง) ส่วน `/api/verify/pdf` ตรวจในหน่วยความจำ ไม่บันทึกไฟล์ — path อื่น (รวม `/api/auth/*`) อยู่ใต้ WAF ตามปกติ

**แจ้งงานเครือข่าย (อื่น ๆ)**
- `/api/*` และ `/msumyid-files/*` ห้าม cache (มีไฟล์ `.p12` ที่มี private key — nginx ส่ง `no-store` แล้ว ขอให้ตั้ง Cache Rule "Bypass" ด้วย)
- ขนาด request สูงสุดของแผนที่ใช้ (Free/Pro 100 MB) ต้องไม่ต่ำกว่าเพดาน ZIP ของระบบ — ไม่เช่นนั้นลดเพดานให้ตรงกัน
- อาการเมื่อ WAF บล็อก: 403 แบบ `text/html` พร้อม header `cf-ray` และคำขอ**ไม่ปรากฏ**ใน `access.log` ของ nginx → ส่ง Ray ID ให้งานเครือข่าย (หน้าลงนามแสดง "ระบบป้องกันของเครือข่ายปฏิเสธการอัปโหลด กรุณาแจ้งผู้ดูแลระบบ") — ดูกฎที่บล็อกได้ที่ Security → Events ของ Cloudflare

## 13. Checklist ก่อนเปิดใช้จริง

- [ ] `NODE_ENV=production` (cookie ได้ `Secure`), `TRUST_PROXY=1`
- [ ] realip ของ Cloudflare — `access.log` ของ nginx แสดง IP จริง ไม่ใช่ `104.x`/`172.64–71.x`/`162.158.x`
- [ ] WAF Skip rule ของ Cloudflare ครบ (หัวข้อ 12) — ลองลงนาม PDF, ตั้งภาพลายเซ็นแบบอัปโหลด และตรวจ PDF ที่ `/verify` ผ่าน
- [ ] secret ทุกตัวสุ่มใหม่ ไม่ใช้ค่าจาก dev; `.env`, `env/*.env`, `secrets/*`, `ca/*.key.pem` สิทธิ์ `600` เจ้าของ deploy
- [ ] `escrow_kek` สำรองนอก VM แล้ว (ผู้ดูแล 2 คน) และ**ไม่อยู่**ในปลายทาง backup
- [ ] redirect URI ของ Google ตรงทุกตัวอักษร, OAuth consent screen เป็น Internal
- [ ] `docker compose ps` — postgres และ signer ไม่มี port, web/api เป็น `127.0.0.1:` เท่านั้น
- [ ] ใบรับรอง TLS รวม intermediate chain (`openssl s_client -connect did.msu.ac.th:443 -servername did.msu.ac.th`)
- [ ] นำเข้าใบเดิมครบ และ CRL มีใบที่เพิกถอนเดิมครบ ก่อนตั้ง timer บน cdp
- [ ] cron backup ทำงาน และกำหนด `BACKUP_REMOTE` แล้ว
- [ ] cron `archive-logs.sh` ทำงาน และ logrotate ของ nginx เก็บ 90 วัน (`docs/design/pdpa.md`)
- [ ] ทดลอง restore อย่างน้อย 1 ครั้ง (รวมดาวน์โหลด `.p12` ซ้ำจาก key สำรองหลัง restore)
- [ ] super_admin คนแรกเข้าใช้ได้

## 14. เรื่องที่ยังเปิดอยู่

1. ปลายทาง backup นอก VM (`BACKUP_REMOTE`)
2. การแจ้งเตือนเมื่อระบบล่ม (เช่น uptime monitor เรียก `https://did.msu.ac.th/api/health`) และเมื่อ CRL ใกล้หมดอายุ
3. เครื่องมือหมุน KEK (re-wrap key สำรอง)
4. Garage — เพิ่มเมื่อมีฟีเจอร์อัปโหลดไฟล์ (ต้องเพิ่ม service, nginx path, backup และข้อยกเว้น WAF)
