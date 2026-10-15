import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // production: image เล็ก รันด้วย node apps/web/server.js (ไม่ต้องมี node_modules ทั้งชุด)
  output: 'standalone',
  // monorepo (pnpm workspaces) — ให้ตามไฟล์ที่ต้องใช้จาก root ของ repo
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
};

export default nextConfig;
