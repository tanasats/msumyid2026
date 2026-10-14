// Next.js เรียก register() ครั้งเดียวตอนเริ่ม server — ตรวจ env ให้ครบก่อนรับคำขอ (CLAUDE.md หัวข้อ 6)
// ขาดตัวใดให้หยุด process ทันที (Next.js แค่ log error แล้วเปิด server ต่อ container จะดูเหมือนปกติ)
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerConfig } = await import('./lib/config');
    try {
      assertServerConfig();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }
}
