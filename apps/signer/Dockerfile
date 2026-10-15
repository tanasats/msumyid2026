# image ของบริการเซ็น — build จาก root ของ repo:  docker build -f apps/signer/Dockerfile .
# ใส่เฉพาะใบรับรองสาธารณะของ CA (ca/*.cert.pem) — key ของ CA mount จาก host ตอนรัน ห้ามอยู่ใน image
ARG NODE_IMAGE=node:22.17.0-alpine3.22

FROM ${NODE_IMAGE} AS base
# pnpm ต้องตรงกับ packageManager ใน package.json (corepack ของ Node 22 ใช้กับ pnpm 12 ไม่ได้)
ARG PNPM_VERSION=12.9.1
RUN npm install -g --no-fund --no-audit pnpm@${PNPM_VERSION}
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/signer/package.json apps/signer/
RUN pnpm install --frozen-lockfile --filter signer
COPY tsconfig.base.json ./
COPY apps/signer apps/signer
RUN pnpm --filter signer build \
  && pnpm --filter signer deploy --prod --legacy /out \
  && cp -r apps/signer/dist /out/ \
  && mkdir -p /out/ca && cp apps/signer/ca/*.cert.pem /out/ca/

FROM ${NODE_IMAGE}
# OpenSSL CLI ใช้ออกใบรับรอง/สร้าง .p12 (เวอร์ชันตาม image Alpine ที่ pin ไว้)
RUN apk add --no-cache openssl
ENV NODE_ENV=production
WORKDIR /app
# คัดลอกเฉพาะที่ต้องใช้ (allowlist) — ไม่พึ่ง .dockerignore อย่างเดียว กันไฟล์ dev หลุดเข้า image
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/ca ./ca
USER node
EXPOSE 4020
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
