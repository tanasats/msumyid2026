#!/usr/bin/env bash
# ติดตั้ง/ปรับปรุงช่วง IP ของ Cloudflare ให้ nginx เชื่อ CF-Connecting-IP:  ./scripts/update-cloudflare-realip.sh
# ตรวจปีละ 1-2 ครั้ง (https://www.cloudflare.com/ips/) — nginx -t ไม่ผ่าน = คืนไฟล์เดิม
set -euo pipefail

TARGET=/etc/nginx/snippets/cloudflare-realip.conf
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "# สร้างโดย update-cloudflare-realip.sh เมื่อ $(date -Is) — อย่าแก้มือ"
  for list in ips-v4 ips-v6; do
    curl -fsS --max-time 15 "https://www.cloudflare.com/$list" | while read -r cidr; do
      [[ -n "$cidr" ]] && echo "set_real_ip_from $cidr;"
    done
  done
  echo "real_ip_header CF-Connecting-IP;"
} > "$TMP"

# ป้องกันกรณีดึงได้ไม่ครบ (เช่น Cloudflare ตอบหน้า error)
count="$(grep -c '^set_real_ip_from' "$TMP")"
[[ "$count" -ge 10 ]] || { echo "ได้ช่วง IP เพียง $count รายการ — ไม่ติดตั้ง" >&2; exit 1; }

sudo mkdir -p /etc/nginx/snippets
[[ -f "$TARGET" ]] && sudo cp "$TARGET" "$TARGET.bak"
sudo install -m 644 "$TMP" "$TARGET"
if sudo nginx -t; then
  sudo systemctl reload nginx
  echo "ติดตั้ง $TARGET แล้ว ($count ช่วง)"
else
  echo "nginx -t ไม่ผ่าน — คืนไฟล์เดิม" >&2
  if [[ -f "$TARGET.bak" ]]; then sudo mv "$TARGET.bak" "$TARGET"; else sudo rm -f "$TARGET"; fi
  exit 1
fi
