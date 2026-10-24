import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { config } from '../src/config/index.js';
import { signPdf } from '../src/services/pdf-signing/index.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { signer } from '../src/services/signer-client.js';

// ทดลองลงนาม PDF ครบวงจรบนเครื่อง dev (ระยะ D0 ของ docs/design/document-signing.md):
// ออกใบรับรองชั่วคราวจาก signer (CA ปลอมของ dev ไม่บันทึกลงฐานข้อมูล) → ลงนาม → ประทับเวลาด้วย TSA จริง → ตรวจด้วยตัวตรวจของ /verify
// ใช้: pnpm --filter api pdf:sign-sample -- --out <โฟลเดอร์> [--in <ไฟล์.pdf>] [--lock] [--profile primary|supplementary]
// ห้ามใช้กับ production (ใบที่ออกจะไม่อยู่ในฐานข้อมูล จึงเพิกถอนผ่านระบบไม่ได้)

const DAY = 24 * 60 * 60 * 1000;

async function samplePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('MSU Digital ID - sample document for signing test', { x: 60, y: 760, size: 16, font });
  page.drawText(`Generated ${new Date().toISOString()}`, { x: 60, y: 730, size: 11, font });
  return Buffer.from(await doc.save());
}

async function main(): Promise<number> {
  if (config.nodeEnv === 'production') {
    console.error('สคริปต์นี้ใช้ทดสอบบนเครื่อง dev เท่านั้น');
    return 1;
  }
  // pnpm ส่ง "--" ต่อมาด้วย — ตัดออกก่อนแยก argument
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      out: { type: 'string' },
      in: { type: 'string' },
      lock: { type: 'boolean', default: false },
      profile: { type: 'string', default: 'supplementary' },
    },
  });
  if (!values.out) {
    console.error('ต้องระบุ --out <โฟลเดอร์ผลลัพธ์>');
    return 1;
  }
  await mkdir(values.out, { recursive: true });

  const now = Date.now();
  const issued = await signer.issueCertificate({
    commonName: 'ทดสอบ ลงนามเอกสาร',
    email: 'signing.test@msu.ac.th',
    p12Password: 'test-p12-1234',
    legacyP12: false,
    ...(values.profile === 'primary'
      ? { validityDays: 30 }
      : { profile: 'document_signing', notBefore: new Date(now), notAfter: new Date(now + 7 * DAY) }),
  });

  const input = values.in ? await readFile(values.in) : await samplePdf();
  const { pdf, timestampTime } = await signPdf(input, {
    certificate: { serialNumber: issued.serialNumber, certificatePem: issued.certificatePem, escrow: issued.escrow },
    signerName: 'ทดสอบ ลงนามเอกสาร',
    lock: values.lock,
  });

  const name = `signed-${values.profile}${values.lock ? '-locked' : ''}.pdf`;
  await writeFile(path.join(values.out, name), pdf);
  await writeFile(path.join(values.out, `signer-${values.profile}.p12`), issued.p12);

  const report = await verifyPdfSignatures(pdf);
  console.log(`ลงนามแล้ว: ${path.join(values.out, name)} (timestamp ${timestampTime.toISOString()})`);
  for (const s of report.signatures) {
    console.log(
      JSON.stringify(
        {
          verdict: s.verdict,
          integrity: s.integrity,
          coversWholeDocument: s.coversWholeDocument,
          chain: s.chain.status,
          signingTime: s.signingTime,
          timestamp: s.timestamp,
          findings: s.findings,
        },
        null,
        2,
      ),
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
