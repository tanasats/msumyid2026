#!/usr/bin/env bash
# กลับไปเวอร์ชันก่อนหน้า:  ./scripts/rollback.sh            (แท็กก่อนหน้าใน deployed.log)
#                        ./scripts/rollback.sh sha-xxxxxxx
# ไม่ย้อน migration — ต้องย้อน schema จริงให้ restore จาก backups/*-pre-<แท็ก> (docs/deployment.md)
source "$(dirname "$0")/lib.sh"

check_files
CURRENT="$(env_get APP_TAG)"
TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  [[ -f deployed.log ]] || die "ไม่มี deployed.log ให้ระบุแท็กเอง"
  # แท็กล่าสุดที่ไม่ใช่เวอร์ชันปัจจุบัน
  TARGET="$(awk '{print $2}' deployed.log | grep -vx "$CURRENT" | tail -n1 || true)"
  [[ -n "$TARGET" ]] || die "ไม่พบเวอร์ชันก่อนหน้าใน deployed.log"
fi
valid_tag "$TARGET" || die "แท็กไม่ถูกต้อง: $TARGET"

log "rollback $CURRENT → $TARGET (ไม่ย้อน migration)"
APP_TAG="$TARGET" docker compose pull signer api web || die "pull $TARGET ไม่สำเร็จ"
if ! switch_to "$TARGET"; then
  log "$TARGET ไม่ healthy — กลับไป $CURRENT"
  switch_to "$CURRENT" || die "กลับไป $CURRENT ไม่สำเร็จ ตรวจด้วย docker compose ps / logs"
  die "rollback ไป $TARGET ไม่สำเร็จ ระบบยังใช้ $CURRENT"
fi
printf '%s %s rollback (from %s)\n' "$(date -Is)" "$TARGET" "$CURRENT" >> deployed.log
log "rollback เป็น $TARGET สำเร็จ"
