#!/usr/bin/env bash
# สำรองข้อมูล:  ./scripts/backup.sh [ป้าย]   (cron: ./scripts/backup.sh daily)
# สร้าง backups/<เวลา>-<ป้าย>/  db.dump (pg_dump -Fc) + env.tgz (.env, env/*.env)
#
# ⚠ ไม่เก็บ secrets/ และ ca/ ไว้ใน backup นี้โดยตั้งใจ: ฐานข้อมูลมี key ส่วนตัวของผู้ใช้ที่เข้ารหัสด้วย ESCROW_KEK
#   ถ้า KEK อยู่ชุดเดียวกับ db.dump ใครได้ backup ไปก็ถอด key ของผู้ใช้ได้ทุกคน
#   KEK / passphrase / key ของ CA เก็บแยกนอก VM ตาม docs/deployment.md หัวข้อ "CA และ signer"
source "$(dirname "$0")/lib.sh"

LABEL="${1:-manual}"
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "ป้ายใช้ได้เฉพาะ A-Z a-z 0-9 . _ -"
KEEP_DAYS="$(env_get BACKUP_KEEP_DAYS)"; KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="$(env_get BACKUP_REMOTE || true)"

umask 077
DIR="backups/$(date +%Y%m%d-%H%M%S)-$LABEL"
mkdir -p "$DIR"

log "pg_dump → $DIR/db.dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DIR/db.dump" \
  || { rm -rf "$DIR"; die "pg_dump ไม่สำเร็จ"; }
[[ -s "$DIR/db.dump" ]] || { rm -rf "$DIR"; die "db.dump ว่าง"; }

log "env → $DIR/env.tgz (ไม่รวม secrets/ และ ca/)"
tar czf "$DIR/env.tgz" .env env/*.env

# ลบชุดที่เก่ากว่า KEEP_DAYS วัน
find backups -mindepth 1 -maxdepth 1 -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +

if [[ -n "$REMOTE" ]]; then
  log "rsync → $REMOTE"
  rsync -a --chmod=D700,F600 backups/ "$REMOTE/" || die "rsync ไป $REMOTE ไม่สำเร็จ (backup บน VM ยังอยู่)"
else
  log "คำเตือน: ยังไม่กำหนด BACKUP_REMOTE — backup อยู่บน VM เดียวกับระบบ"
fi
log "backup เสร็จ: $DIR"
