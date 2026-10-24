#!/usr/bin/env bash
# เตรียม Garage (ที่เก็บไฟล์ของการลงนามเอกสาร) ครั้งแรก:  ./scripts/init-garage.sh   (รันซ้ำได้ ไม่สร้างซ้ำ)
# 1. เปิด container garage  2. กำหนด layout ของ node เดียว  3. สร้าง key ของ API + bucket (S3_BUCKET ใน env/api.env)
# 4. เขียน key ลง secrets/s3_access_key, secrets/s3_secret_key (ไม่เขียนทับ)
# ต้องรัน ./scripts/init-secrets.sh ก่อน (ต้องมี secrets/garage_rpc_secret, secrets/garage_admin_token)
source "$(dirname "$0")/lib.sh"

KEY_NAME=msumyid-api
CAPACITY="${GARAGE_CAPACITY:-20G}"
BUCKET="$(env_get S3_BUCKET env/api.env)"
[[ -n "$BUCKET" ]] || die "env/api.env ไม่มีค่า S3_BUCKET"
[[ -s secrets/garage_rpc_secret && -s secrets/garage_admin_token ]] || die "ยังไม่มี secret ของ Garage — รัน ./scripts/init-secrets.sh ก่อน"

garage() { docker compose exec -T -e RUST_LOG=warn garage /garage "$@"; }

docker compose up -d garage
log "รอ Garage พร้อม"
for _ in $(seq 1 30); do
  if garage status >/dev/null 2>&1; then break; fi
  sleep 1
done
garage status >/dev/null || die "Garage ไม่ตอบ — ดู docker compose logs garage"

# layout: node เดียว ยังไม่เคยกำหนด = สถานะขึ้น "NO ROLE ASSIGNED"
if garage status | grep -q 'NO ROLE ASSIGNED'; then
  node_id="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c "$CAPACITY" "$node_id" >/dev/null
  garage layout apply --version 1 >/dev/null
  log "กำหนด layout แล้ว (node ${node_id:0:16}…, ${CAPACITY})"
else
  log "layout กำหนดไว้แล้ว"
fi

if garage key info "$KEY_NAME" >/dev/null 2>&1; then
  log "key '$KEY_NAME' มีอยู่แล้ว"
else
  garage key create "$KEY_NAME" >/dev/null
  log "สร้าง key '$KEY_NAME'"
fi
if garage bucket info "$BUCKET" >/dev/null 2>&1; then
  log "bucket '$BUCKET' มีอยู่แล้ว"
else
  garage bucket create "$BUCKET" >/dev/null
  log "สร้าง bucket '$BUCKET'"
fi
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_NAME" >/dev/null

umask 077
if [[ ! -s secrets/s3_access_key || ! -s secrets/s3_secret_key ]]; then
  info="$(garage key info "$KEY_NAME" --show-secret)"
  printf '%s' "$(sed -n 's/^Key ID: *//p' <<<"$info")" > secrets/s3_access_key
  printf '%s' "$(sed -n 's/^Secret key: *//p' <<<"$info")" > secrets/s3_secret_key
  [[ -s secrets/s3_access_key && -s secrets/s3_secret_key ]] || die "อ่าน key ของ Garage ไม่ได้ — ตรวจด้วย: docker compose exec garage /garage key info $KEY_NAME"
  chmod 600 secrets/s3_access_key secrets/s3_secret_key
  log "เขียน secrets/s3_access_key และ secrets/s3_secret_key แล้ว"
else
  log "secrets/s3_* มีอยู่แล้ว (ไม่เขียนทับ)"
fi
log "เสร็จ — ต่อด้วย ./scripts/deploy.sh <แท็ก> (หรือ docker compose up -d api ถ้าใช้แท็กเดิม)"
