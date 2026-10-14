# image ของหน้าเว็บ (Next.js standalone) — build จาก root ของ repo:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://did.msu.ac.th/api .
# NEXT_PUBLIC_* ถูกฝังลงโค้ดฝั่ง browser ตอน build เปลี่ยนภายหลังด้วย env ไม่ได้ ต้อง build ใหม่
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
RUN pnpm install --frozen-lockfile --filter web
COPY tsconfig.base.json ./
COPY apps/web apps/web
ARG NEXT_PUBLIC_API_URL
RUN test -n "$NEXT_PUBLIC_API_URL" || (echo "ต้องระบุ --build-arg NEXT_PUBLIC_API_URL" && exit 1)
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

FROM ${NODE_IMAGE}
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
