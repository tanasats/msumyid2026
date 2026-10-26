#!/usr/bin/env bash
# เก็บ log ของเมื่อวานจากทุก container แล้วลบชุดที่เก่ากว่า LOG_KEEP_DAYS วัน (ไม่ใส่ = 90)
# cron (ผู้ใช้ deploy): 15 0 * * * /opt/msumyid/scripts/archive-logs.sh >> /opt/msumyid/logs/cron.log 2>&1
# ระยะเก็บ 90 วันตามประกาศความเป็นส่วนตัว (docs/design/pdpa.md) และ พ.ร.บ.คอมพิวเตอร์ ม.26 (ข้อมูลจราจรอย่างน้อย 90 วัน)
# log ระหว่างวันของ container ที่ถูกสร้างใหม่ตอน deploy/rollback ถูกเก็บไว้แล้วใน switch_to (ไฟล์ <service>-<เวลา>.log.gz)
source "$(dirname "$0")/lib.sh"

KEEP_DAYS="$(env_get LOG_KEEP_DAYS || true)"; KEEP_DAYS="${KEEP_DAYS:-90}"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || die "LOG_KEEP_DAYS ต้องเป็นตัวเลข"

YESTERDAY="$(date -d yesterday +%Y-%m-%d)"
log "เก็บ log ของ $YESTERDAY → logs/$YESTERDAY/"
archive_logs "$(date -d yesterday +%Y-%m-%dT00:00:00%:z)" "$(date +%Y-%m-%dT00:00:00%:z)" "$YESTERDAY"

# ลบชุดที่เก่ากว่า KEEP_DAYS วัน (ชื่อโฟลเดอร์เป็นวันที่ เทียบเป็นข้อความได้)
CUTOFF="$(date -d "$KEEP_DAYS days ago" +%Y-%m-%d)"
for d in logs/????-??-??; do
  [[ -d "$d" && "$(basename "$d")" < "$CUTOFF" ]] && rm -rf -- "$d" && log "ลบ $d"
done
log "เสร็จ"
