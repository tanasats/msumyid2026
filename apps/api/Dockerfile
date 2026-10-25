# image ของ API — build จาก root ของ repo:  docker build -f apps/api/Dockerfile .
# มี migrations ในตัว: container เดียวกันใช้รัน migrate ได้ (deploy/compose.yml service migrate)
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
RUN pnpm install --frozen-lockfile --filter api
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter api build \
  && pnpm --filter api deploy --prod --legacy /out \
  && cp -r apps/api/dist apps/api/migrations apps/api/assets /out/

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# คัดลอกเฉพาะที่ต้องใช้ (allowlist) — ไม่พึ่ง .dockerignore อย่างเดียว กันไฟล์ dev หลุดเข้า image
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/migrations ./migrations
# ฟอนต์ Sarabun (OFL) สำหรับข้อความในลายมือชื่อแบบมองเห็น — src/services/pdf-signing/appearance.ts อ่านจาก /app/assets
COPY --from=build --chown=node:node /out/assets ./assets
USER node
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
