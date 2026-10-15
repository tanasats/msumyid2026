#!/usr/bin/env bash
# deploy เวอร์ชันใหม่:  ./scripts/deploy.sh sha-abc1234
# ขั้นตอน: ตรวจไฟล์ → backup → pull → migrate → สลับ + รอ healthy (ไม่ผ่าน = กลับเวอร์ชันเดิมอัตโนมัติ) → บันทึก deployed.log
source "$(dirname "$0")/lib.sh"

TAG="${1:-}"
valid_tag "$TAG" || die "ใช้: $0 sha-<commit 7-40 ตัว>"

check_files
PREV="$(env_get APP_TAG)"
log "deploy $PREV → $TAG"

# postgres ต้องทำงานก่อน backup/migrate (deploy ครั้งแรกจะสร้างให้)
docker compose up -d --wait postgres

"$ROOT/scripts/backup.sh" "pre-$TAG"

log "pull image $TAG"
APP_TAG="$TAG" docker compose --profile tools pull signer api web migrate \
  || die "pull ไม่สำเร็จ — ยังไม่ได้เปลี่ยนอะไร (ตรวจ docker login ghcr.io และแท็ก)"

log "migrate"
APP_TAG="$TAG" docker compose run --rm migrate \
  || die "migrate ไม่สำเร็จ — เวอร์ชันเดิม ($PREV) ยังทำงานอยู่ ถ้า migration ทำไปบางส่วนให้กู้จาก backups/*-pre-$TAG"

log "สลับเป็น $TAG"
if ! switch_to "$TAG"; then
  log "เวอร์ชันใหม่ไม่ healthy — กลับไป $PREV"
  docker compose logs --tail 50 signer api web || true
  switch_to "$PREV" || die "กลับเวอร์ชันเดิมไม่สำเร็จ ตรวจด้วย docker compose ps / logs"
  printf '%s %s rollback-auto (from %s)\n' "$(date -Is)" "$PREV" "$TAG" >> deployed.log
  die "deploy $TAG ไม่สำเร็จ ระบบกลับไปใช้ $PREV แล้ว"
fi

printf '%s %s\n' "$(date -Is)" "$TAG" >> deployed.log
log "deploy $TAG สำเร็จ"
docker compose ps
