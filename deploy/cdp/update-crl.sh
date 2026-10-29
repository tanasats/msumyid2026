#!/usr/bin/env bash
# อัปเดต msu-ca.crl บน cdp.msu.ac.th จากระบบ MSU Digital ID — ติดตั้งบนเครื่อง cdp (ไม่ใช่ VM ของระบบ) ดู docs/deployment.md หัวข้อ 10
# รันทุก 10 นาทีด้วย msu-crl.timer (หรือ cron) — แทนที่ไฟล์เฉพาะเมื่อ CRL ใหม่ผ่านการตรวจทุกข้อ ไม่ผ่าน = คงฉบับเดิม + log ไว้แจ้งเตือน
set -euo pipefail

SOURCE_URL="${SOURCE_URL:-https://did.msu.ac.th/api/crl/msu-ca.crl}"
TARGET="${TARGET:-/var/www/cdp/msu-ca.crl}"
# ใบของ CA ที่ออก CRL (univ-ca.cert.pem) + root (root.cert.pem) ต่อกันในไฟล์เดียว — เป็นข้อมูลสาธารณะ
CA_CHAIN="${CA_CHAIN:-/etc/msu-cdp/ca-chain.pem}"
# ฉบับใหม่ต้องเหลืออายุ (next update) อย่างน้อยเท่านี้ — กันนำฉบับที่ใกล้หมดอายุขึ้นเผยแพร่
MIN_REMAINING_HOURS="${MIN_REMAINING_HOURS:-24}"
# ฉบับที่เผยแพร่อยู่เหลืออายุน้อยกว่านี้ = แจ้งเตือน (ดึงฉบับใหม่ไม่ได้มานานแล้ว)
STALE_WARN_HOURS="${STALE_WARN_HOURS:-72}"
# ระบบตัดใบที่เพิกถอนแล้วหมดอายุครบ 30 วันออกจาก CRL (CRL_EXPIRED_RETENTION_DAYS ใน apps/api/src/services/crl-service.ts)
# ใบที่เพิกถอนภายในกี่วันล่าสุดต้องยังอยู่ในฉบับใหม่ — ต้องไม่เกินค่าของระบบ
# (ใบที่ระบบตัดออกหมดอายุก่อน 30 วันที่แล้ว จึงต้องถูกเพิกถอนก่อนนั้นด้วย)
RECENT_DAYS="${RECENT_DAYS:-30}"
ALLOWED_PROTO="${ALLOWED_PROTO:-https}"
LOCK_FILE="${LOCK_FILE:-/run/lock/msu-crl.lock}"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2
  if command -v logger >/dev/null; then logger -t msu-crl -- "$*"; fi
}
die() {
  log "ERROR: $*"
  exit 1
}

# กันรอบซ้อนกัน (รอบก่อนยังไม่จบ)
if command -v flock >/dev/null; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || exit 0
fi

form_of() { if grep -q -- '-----BEGIN X509 CRL-----' "$1"; then echo PEM; else echo DER; fi; }
crl() { local f=$1; shift; openssl crl -in "$f" -inform "$(form_of "$f")" -noout "$@"; }
crl_number() { crl "$1" -crlnumber | sed -E 's/^crlNumber=(0x)?//'; }
next_update() { date -u -d "$(crl "$1" -nextupdate | sed 's/^nextUpdate=//')" +%s; }
revoked_count() { crl "$1" -text | grep -c 'Serial Number:' || true; }
# serial ของใบที่เพิกถอน 1 บรรทัดต่อใบ — ทั้งหมด หรือเฉพาะที่เพิกถอนตั้งแต่เวลา $2 (Unix) เป็นต้นไป
revoked_serials() {
  local since=${2:-}
  crl "$1" -text | awk '
    /Serial Number:/ { serial = $3 }
    /Revocation Date:/ { sub(/.*Revocation Date: */, ""); print serial "\t" $0 }
  ' | while IFS=$'\t' read -r serial revoked_at; do
    if [[ -z "$since" ]] || (($(date -u -d "$revoked_at" +%s) >= since)); then echo "$serial"; fi
  done | sort -u
}

now=$(date -u +%s)

# 0. แจ้งเตือนเมื่อฉบับที่เผยแพร่อยู่ใกล้หมดอายุ (ทำก่อน เพื่อให้เตือนแม้รอบนี้ดึงไม่สำเร็จ)
if [[ -f "$TARGET" ]]; then
  current_next=$(next_update "$TARGET")
  if ((current_next - now < STALE_WARN_HOURS * 3600)); then
    log "WARN: CRL ที่เผยแพร่อยู่จะหมดอายุ $(date -u -d "@$current_next" +%Y-%m-%dT%H:%MZ) — ตรวจการดึงจาก $SOURCE_URL"
  fi
fi

dir=$(dirname "$TARGET")
tmp=$(mktemp "$dir/.msu-ca.crl.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# 1. ดาวน์โหลด (ต้องเป็น HTTPS, ตรวจใบรับรองของเว็บ, จำกัดเวลาและขนาด)
curl -fsS --proto "=$ALLOWED_PROTO" --max-time 30 --max-filesize 10000000 -o "$tmp" "$SOURCE_URL" ||
  die "ดาวน์โหลดไม่สำเร็จจาก $SOURCE_URL"

# 2. เป็น CRL ที่ CA ของมหาวิทยาลัยเซ็นจริง (ได้หน้า error / ไฟล์เสีย / CA อื่น = ไม่ผ่าน)
crl "$tmp" -CAfile "$CA_CHAIN" 2>/dev/null || die "ลายเซ็นของ CRL ไม่ถูกต้อง หรือไม่ได้ออกโดย CA ของมหาวิทยาลัย"

# 3. ยังไม่ใกล้หมดอายุ
new_next=$(next_update "$tmp")
((new_next - now >= MIN_REMAINING_HOURS * 3600)) ||
  die "CRL ใหม่เหลืออายุไม่ถึง $MIN_REMAINING_HOURS ชั่วโมง (next update $(date -u -d "@$new_next" +%Y-%m-%dT%H:%MZ))"

new_number=$(crl_number "$tmp")
new_count=$(revoked_count "$tmp")

# 4. ไม่ย้อนไปฉบับเก่า และการเพิกถอนล่าสุดไม่หายไป — กัน CRL ว่าง / ฐานข้อมูลที่กู้จาก backup เก่าทับ
#    ใบที่เพิกถอนนานแล้วหายไปได้ (ระบบตัดใบที่หมดอายุออก)
if [[ -f "$TARGET" ]]; then
  old_number=$(crl_number "$TARGET")
  old_count=$(revoked_count "$TARGET")
  if ((16#$new_number == 16#$old_number)); then
    exit 0 # ฉบับเดิม ไม่ต้องทำอะไร
  fi
  ((16#$new_number > 16#$old_number)) || die "เลข CRL ใหม่ ($new_number) น้อยกว่าฉบับที่เผยแพร่อยู่ ($old_number) — ไม่แทนที่"
  ((new_count > 0 || old_count == 0)) || die "CRL ใหม่ไม่มีใบที่เพิกถอนเลย (ฉบับเดิมมี $old_count ใบ) — ไม่แทนที่ ตรวจระบบต้นทางก่อน"
  missing=$(comm -23 <(revoked_serials "$TARGET" $((now - RECENT_DAYS * 86400))) <(revoked_serials "$tmp"))
  [[ -z "$missing" ]] ||
    die "ใบที่เพิกถอนภายใน $RECENT_DAYS วันหายไปจาก CRL ใหม่ ($(wc -l <<<"$missing") ใบ เช่น $(head -n1 <<<"$missing")) — ไม่แทนที่ ตรวจระบบต้นทางก่อน"
  cp -p "$TARGET" "$TARGET.prev"
fi

# 5. แทนที่แบบ atomic (mv ในโฟลเดอร์เดียวกัน) — ผู้ดาวน์โหลดไม่เห็นไฟล์ครึ่ง ๆ
chmod 644 "$tmp"
mv -f "$tmp" "$TARGET"
trap - EXIT
log "อัปเดต CRL เลข $new_number ใบที่เพิกถอน $new_count ใบ next update $(date -u -d "@$new_next" +%Y-%m-%dT%H:%MZ)"
