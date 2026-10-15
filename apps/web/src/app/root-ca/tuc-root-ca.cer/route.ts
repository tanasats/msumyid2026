import { ROOT_CA_FILE_NAME, getRootCa } from '@/lib/root-ca';

// ดาวน์โหลดใบรับรอง root ของ Thai University Consortium แบบ DER (.cer) — public ไม่ต้อง login (ข้อมูลสาธารณะ)
export async function GET() {
  const { der } = getRootCa();
  return new Response(new Uint8Array(der), {
    headers: {
      'Content-Type': 'application/pkix-cert',
      'Content-Disposition': `attachment; filename="${ROOT_CA_FILE_NAME}"`,
      'Content-Length': String(der.length),
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
