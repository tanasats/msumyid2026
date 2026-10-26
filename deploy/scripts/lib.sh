#!/usr/bin/env bash
# ฟังก์ชันที่สคริปต์ใน deploy/scripts ใช้ร่วมกัน — source จากสคริปต์อื่น ไม่ได้รันตรง
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "ผิดพลาด: $*" >&2; exit 1; }

# อ่านค่าจาก .env (ไม่ source ทั้งไฟล์ เพื่อไม่รันอะไรที่อยู่ในนั้น)
env_get() {
  local key="$1" file="${2:-.env}"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2-
}

env_set() {
  local key="$1" value="$2" file="${3:-.env}"
  sed -i "s|^${key}=.*|${key}=${value}|" "$file"
}

valid_tag() { [[ "$1" =~ ^sha-[0-9a-f]{7,40}$ ]]; }

# ตรวจก่อนแตะระบบ: ไฟล์ env/secret/key ต้องครบและไม่ว่าง (ไฟล์หาย = หยุดทันที ดู docs/deployment.md หัวข้อ "ไฟล์ env หาย")
check_files() {
  local f missing=0
  for f in .env env/api.env env/web.env env/signer.env env/postgres.env; do
    [[ -s "$f" ]] || { log "ไม่พบหรือว่าง: $f"; missing=1; }
  done
  for f in secrets/signer_token secrets/ca_key_passphrase secrets/escrow_kek ca/univ-ca.key.pem \
    secrets/garage_rpc_secret secrets/garage_admin_token secrets/s3_access_key secrets/s3_secret_key; do
    [[ -s "$f" ]] || { log "ไม่พบหรือว่าง: $f"; missing=1; }
  done
  [[ $missing -eq 0 ]] || die "ไฟล์ไม่ครบ — กู้ env ด้วย scripts/recover-env.sh หรือจาก backup ก่อน (ห้าม deploy/up/down จนกว่าจะกู้เสร็จ)"

  local key
  for key in APP_TAG IMAGE_PREFIX APP_UID APP_GID; do
    [[ -n "$(env_get "$key")" ]] || die ".env ไม่มีค่า $key"
  done
  for key in DATABASE_URL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI WEB_URL S3_PUBLIC_ENDPOINT S3_BUCKET; do
    [[ -n "$(env_get "$key" env/api.env)" ]] || die "env/api.env ไม่มีค่า $key"
  done
  docker compose config -q || die "docker compose config ไม่ผ่าน"
}

# image ของ api แท็กนี้มี worker ลงนามเอกสารหรือไม่ (เวอร์ชันก่อน D1 ไม่มี dist/src/worker.js)
has_worker() {
  docker run --rm --entrypoint test "$(env_get IMAGE_PREFIX)-api:$1" -f dist/src/worker.js
}

# สลับ signer/api/web/worker ไปแท็กที่ระบุ แล้วรอจน healthy (เก็บ log ของ container เดิมก่อน — archive_logs)
# rollback ไปเวอร์ชันที่ยังไม่มี worker: หยุด worker ตัวเดิม (งานที่ค้างรออยู่ในคิว ไม่หาย) แล้วสลับเฉพาะ signer/api/web
switch_to() {
  local tag="$1" services=(signer api web)
  # container เดิมจะถูกสร้างใหม่ (log หาย) → เก็บ log ตั้งแต่ต้นวันถึงตอนนี้ไว้ก่อน
  archive_logs "$(date +%Y-%m-%dT00:00:00%:z)" "$(date +%Y-%m-%dT%H:%M:%S%:z)" "$(date +%Y-%m-%d)" "-$(date +%H%M%S)"
  env_set APP_TAG "$tag"
  if has_worker "$tag"; then
    services+=(worker)
  else
    log "$tag ไม่มี worker ลงนามเอกสาร — หยุด worker"
    docker compose stop worker || true
  fi
  docker compose up -d --wait --wait-timeout 180 "${services[@]}"
}

# เก็บ log ของ container ลง logs/<วันที่>/<service>[-<เวลา>].log.gz (PDPA + พ.ร.บ.คอมพิวเตอร์: เก็บ 90 วัน — docs/design/pdpa.md)
# log ของ Docker อยู่กับ container สร้างใหม่ (deploy) แล้วหาย และหมุนตามขนาด จึงต้องคัดลอกออกมาเก็บเอง
#   archive_logs <since> <until> <วันที่> [ต่อท้ายชื่อไฟล์]   since/until = เวลาแบบ RFC 3339
archive_logs() {
  local since="$1" until="$2" day="$3" suffix="${4:-}" svc
  local dir="logs/$day"
  (umask 077; mkdir -p "$dir")
  for svc in $(docker compose ps --services); do
    (umask 077; docker compose logs --no-color --timestamps --since "$since" --until "$until" "$svc" | gzip > "$dir/$svc$suffix.log.gz") \
      || log "คำเตือน: เก็บ log ของ $svc ไม่สำเร็จ"
  done
}
