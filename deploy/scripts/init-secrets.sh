#!/usr/bin/env bash
# สร้างไฟล์ secret ของ signer ครั้งแรก:  ./scripts/init-secrets.sh
# - signer_token  สุ่มให้ (สร้างใหม่ได้ทุกเมื่อ แล้ว restart signer + api)
# - escrow_kek    สุ่มให้ครั้งเดียว — ต้องสำรองนอก VM ทันที หายแล้วกู้ key สำรองของผู้ใช้ไม่ได้
# - ca_key_passphrase  ผู้ดูแล CA ใส่เอง (ไม่สุ่ม เพราะเป็นรหัสของ key ที่มีอยู่แล้ว)
# - garage_rpc_secret / garage_admin_token  สุ่มให้ (ที่เก็บไฟล์) — key ของ S3 สร้างด้วย scripts/init-garage.sh
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

# Garage (ที่เก็บไฟล์): rpc_secret = hex 32 ไบต์ตามที่ Garage กำหนด, admin_token ใช้กับ garage CLI ใน container เท่านั้น
if [[ ! -s secrets/garage_rpc_secret ]]; then
  openssl rand -hex 32 > secrets/garage_rpc_secret
  log "สร้าง secrets/garage_rpc_secret แล้ว"
fi
if [[ ! -s secrets/garage_admin_token ]]; then
  openssl rand -base64 32 > secrets/garage_admin_token
  log "สร้าง secrets/garage_admin_token แล้ว"
fi

if [[ ! -s secrets/ca_key_passphrase ]]; then
  log "ยังไม่มี secrets/ca_key_passphrase — ผู้ดูแล CA ใส่เองโดยไม่ให้ค้างใน history:"
  log "  read -rs P && printf '%s' \"\$P\" > secrets/ca_key_passphrase && unset P"
fi
if [[ ! -s ca/univ-ca.key.pem ]]; then
  log "ยังไม่มี ca/univ-ca.key.pem — คัดลอก key ของ Intermediate CA มาวาง (chmod 600)"
fi

chmod 600 secrets/* 2>/dev/null || true
