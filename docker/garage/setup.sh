#!/usr/bin/env bash
# สร้าง access key + bucket ของ Garage สำหรับ dev และ test (รันซ้ำได้ ไม่สร้างซ้ำ)
# ใช้: bash docker/garage/setup.sh  (ต้อง docker compose up -d ก่อน)
set -euo pipefail

# กัน Git Bash บน Windows แปลง /garage เป็น path ของ Windows
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/../.."

garage() {
  docker compose exec -T -e RUST_LOG=warn garage /garage "$@"
}

# รอจน Garage พร้อมรับคำสั่ง
for _ in $(seq 1 30); do
  if garage status >/dev/null 2>&1; then break; fi
  sleep 1
done
garage status >/dev/null

# ensure_key_bucket <ชื่อ key> <ชื่อ bucket>
ensure_key_bucket() {
  local key_name="$1" bucket="$2"

  if garage key info "$key_name" >/dev/null 2>&1; then
    echo "• key '$key_name' มีอยู่แล้ว"
  else
    garage key create "$key_name" >/dev/null
    echo "• สร้าง key '$key_name'"
  fi

  if garage bucket info "$bucket" >/dev/null 2>&1; then
    echo "• bucket '$bucket' มีอยู่แล้ว"
  else
    garage bucket create "$bucket" >/dev/null
    echo "• สร้าง bucket '$bucket'"
  fi

  # ให้สิทธิ์ซ้ำได้ไม่เป็นไร (idempotent)
  garage bucket allow --read --write --owner "$bucket" --key "$key_name" >/dev/null
  echo "• ให้สิทธิ์ read/write/owner แก่ '$key_name' บน '$bucket'"
}

ensure_key_bucket msumyid-dev app-files
ensure_key_bucket msumyid-test app-files-test

echo
echo "นำค่าต่อไปนี้ไปใส่ใน apps/api/.env (S3_ACCESS_KEY / S3_SECRET_KEY และ TEST_S3_*):"
for key_name in msumyid-dev msumyid-test; do
  echo "--- $key_name ---"
  garage key info "$key_name" --show-secret | grep -E 'Key ID|Secret key'
done
