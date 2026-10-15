#!/usr/bin/env bash
# กู้ env/*.env ที่หายไป จากค่าที่ container ที่ยังอยู่เก็บไว้:  ./scripts/recover-env.sh
# สร้างเฉพาะไฟล์ที่หาย ไม่ทับไฟล์ที่มีอยู่ — ตรวจค่าที่ได้ด้วยตาก่อน deploy
# (.env ของ compose และ secrets/ กู้ด้วยวิธีนี้ไม่ได้ — ใช้ backups/*/env.tgz และสำเนา secret นอก VM)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
set -euo pipefail

# ตัวแปรที่มาจาก image หรือ compose.yml (ไม่ใช่จากไฟล์ env)
SKIP='^(PATH|HOSTNAME|HOME|NODE_VERSION|YARN_VERSION|NEXT_TELEMETRY_DISABLED|PORT|API_URL|SIGNER_URL|SIGNER_PORT|SIGNER_TOKEN_FILE|CA_KEY_PASSPHRASE_FILE|ESCROW_KEK_FILE|CA_CERT_PATH|CA_CHAIN_PATH|CA_KEY_PATH|PGDATA|PG_MAJOR|PG_VERSION|PG_SHA256|GOSU_VERSION|LANG|DOCKER_PG_LLVM_DEPS)='

umask 077
mkdir -p env
for svc in api web signer postgres; do
  out="env/$svc.env"
  if [[ -s "$out" ]]; then
    echo "มีอยู่แล้ว ข้าม: $out"
    continue
  fi
  cid="$(docker compose ps -aq "$svc" | head -n1)"
  if [[ -z "$cid" ]]; then
    echo "ไม่พบ container ของ $svc — กู้ $out จาก backups/*/env.tgz แทน" >&2
    continue
  fi
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | grep -Ev "$SKIP" | grep -v '^$' > "$out"
  echo "กู้ $out แล้ว ($(wc -l < "$out") ตัวแปร) — ตรวจค่าก่อนใช้"
done
