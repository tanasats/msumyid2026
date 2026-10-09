import { parseArgs } from 'node:util';
import { pool } from '../src/db/pool.js';
import { importLegacyCertificates } from '../src/services/legacy-certificate-import-service.js';

// นำเข้าใบรับรองเดิมจากโฟลเดอร์ของ openssl ca (index.txt, newcerts/, certs/, private/, pkcs12-files.csv)
// ใช้: pnpm --filter api cert:import -- --dir /path/to/ca [--passwords /path/to/pkcs12-files.csv] [--dry-run]
// ต้องเปิดบริการเซ็น (signer) ไว้ — ใช้ถอด key เดิมเก็บเป็น key สำรอง และออก CRL หลังนำเข้า
// แนะนำ: รัน --dry-run ก่อน แล้วค่อยรันจริง (รันซ้ำได้ ข้ามใบที่นำเข้าแล้ว)

async function main(): Promise<number> {
  // pnpm ส่ง "--" ต่อมาด้วยเมื่อรันแบบ cert:import -- --dir ... จึงตัดทิ้งก่อน
  const args = process.argv.slice(2);
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      dir: { type: 'string' },
      passwords: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.dir) {
    console.error('ต้องระบุ --dir <โฟลเดอร์ของ CA เดิม> (โฟลเดอร์ที่มี index.txt)');
    return 1;
  }

  const report = await importLegacyCertificates({
    dir: values.dir,
    passwordsFile: values.passwords,
    dryRun: values['dry-run'],
  });

  console.log(report.dryRun ? '=== ตรวจอย่างเดียว (--dry-run) ไม่มีการบันทึก ===' : '=== นำเข้าใบรับรองเดิม ===');
  console.log(`แถวใน index.txt: ${report.indexEntries}`);
  console.log(`ใบใหม่: ${report.newCertificates} (ถูกเพิกถอนแล้ว ${report.newRevoked})`);
  console.log(`  ผูกกับผู้ใช้ที่มีอยู่: ${report.ownedByExistingUsers}, รอผูกเมื่อผู้ใช้ login: ${report.unowned}`);
  console.log(`เคยนำเข้าแล้ว (ข้าม): ${report.alreadyImported}, ถูกเพิกถอนเพิ่มในระบบเดิม: ${report.newlyRevokedExisting}`);
  console.log(`key เดิม: พบ ${report.keyFiles} ไฟล์, เก็บเป็น key สำรอง ${report.keysEscrowed}`);
  if (!report.dryRun && report.errors.length === 0) {
    console.log(report.crlIssued ? 'ออก CRL ฉบับใหม่แล้ว' : 'ยังไม่ได้ออก CRL (ดูคำเตือน)');
  }
  for (const warning of report.warnings) console.warn(`คำเตือน: ${warning}`);
  if (report.errors.length > 0) {
    for (const error of report.errors) console.error(`ผิดพลาด: ${error}`);
    console.error('หยุดนำเข้า — ไม่มีการบันทึกข้อมูล แก้ไขแล้วรันใหม่');
    return 1;
  }
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error('นำเข้าล้มเหลว:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
