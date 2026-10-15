#!/usr/bin/env bash
# สร้างไฟล์ secret ของ signer ครั้งแรก:  ./scripts/init-secrets.sh
# - signer_token  สุ่มให้ (สร้างใหม่ได้ทุกเมื่อ แล้ว restart signer + api)
# - escrow_kek    สุ่มให้ครั้งเดียว — ต้องสำรองนอก VM ทันที หายแล้วกู้ key สำรองของผู้ใช้ไม่ได้
# - ca_key_passphrase  ผู้ดูแล CA ใส่เอง (ไม่สุ่ม เพราะเป็นรหัสของ key ที่มีอยู่แล้ว)
# ไม่สร้างทับไฟล์ที่มีอยู่
source "$(dirname "$0")/lib.sh"

umask 077
mkdir -p secrets ca
chmod 700 secrets ca

if [[ ! -s secrets/signer_token ]]; then
  openssl rand -hex 32 > secrets/signer_token
  log "สร้าง secrets/signer_token แล้ว"
fi

if [[ ! -s secrets/escrow_kek ]]; then
  openssl rand -base64 32 > secrets/escrow_kek
  log "สร้าง secrets/escrow_kek แล้ว"
  log "⚠ สำรอง KEK นี้นอก VM ทันที (password manager ของผู้ดูแล 2 คน) และห้ามเก็บรวมกับ backup ฐานข้อมูล:"
  log "  cat /opt/msumyid/secrets/escrow_kek   (ESCROW_KEK_ID ใน env/signer.env)"
fi

if [[ ! -s secrets/ca_key_passphrase ]]; then
  log "ยังไม่มี secrets/ca_key_passphrase — ผู้ดูแล CA ใส่เองโดยไม่ให้ค้างใน history:"
  log "  read -rs P && printf '%s' \"\$P\" > secrets/ca_key_passphrase && unset P"
fi
if [[ ! -s ca/univ-ca.key.pem ]]; then
  log "ยังไม่มี ca/univ-ca.key.pem — คัดลอก key ของ Intermediate CA มาวาง (chmod 600)"
fi

chmod 600 secrets/* 2>/dev/null || true
