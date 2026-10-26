import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { clearCrlCache, collectRevocationMaterial, crlFetcher } from '../src/services/ltv-service.js';
import { reserveExistingObjectNumbers, snapshotObjects, writeIncrementalUpdate } from '../src/services/pdf-signing/incremental.js';
import { signPdf } from '../src/services/pdf-signing/index.js';
import { appendDss } from '../src/services/pdf-signing/ltv.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { parseCertificatePem } from '../src/services/signature-verification/pki.js';
import { trustStore } from '../src/services/signature-verification/trust-store.js';
import { signer } from '../src/services/signer-client.js';
import { resetDatabase } from './helpers/db.js';
import { createTestPki, ROOT_CRL_URL } from './helpers/test-pki.js';

// LTV (ระยะ D4b): รวบรวมใบรับรอง + CRL ของลายมือชื่อล่าสุด (CRL ของ CA ระบบจากตาราง crls, CA อื่นดึงจาก CDP)
// ตรวจลายมือชื่อบน CRL ทุกฉบับ, ต่อท้าย DSS, ตัวตรวจรู้จักส่วนต่อท้ายที่เป็น LTV ล้วน และเอกสารล็อกที่ถูกต่อท้าย

const pki = createTestPki();
const certificate = { serialNumber: '1', certificatePem: 'x', escrow: { kekId: 't', encryptedKey: Buffer.alloc(1), wrappedDataKey: Buffer.alloc(1) } };

beforeEach(async () => {
  await resetDatabase();
  clearCrlCache();
  vi.spyOn(signer, 'signCms').mockImplementation(async ({ content }) => pki.signCms(content));
  // root ของ PKI ทดสอบเป็นจุดเชื่อถือ (ต่อสายใบได้ถึง root)
  const root = parseCertificatePem(pki.rootCertPem);
  const real = trustStore.get();
  vi.spyOn(trustStore, 'get').mockReturnValue({
    ...real,
    signerAnchors: [{ name: 'Test Root', certificate: root }],
    timestampAnchors: [{ name: 'Test Root', certificate: root }],
  });
  await pool.query(
    `INSERT INTO crls (crl_number, this_update, next_update, revoked_count, crl_der) VALUES (1, now(), now() + interval '30 days', 0, $1)`,
    [pki.intermediateCrlDer],
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  pki.cleanup();
  await resetDatabase();
  await pool.end();
});

async function signed(lock = false): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('LTV test', { x: 50, y: 780, font, size: 14 });
  const { pdf } = await signPdf(Buffer.from(await doc.save()), { certificate, signerName: 'ผู้ลงนาม', lock, tsaTransport: pki.tsa });
  return pdf;
}

describe('collectRevocationMaterial', () => {
  it('ครบสาย: ใบผู้ลงนาม/TSA/intermediate/root + CRL ของ intermediate (จากตาราง crls) และของ root (ดึงจาก CDP, cache)', async () => {
    const fetch = vi.spyOn(crlFetcher, 'fetch').mockResolvedValue(pki.rootCrlPem);
    const pdf = await signed();
    const result = await collectRevocationMaterial(pdf);
    expect(result.material).not.toBeNull();
    expect(result.material!.certs).toHaveLength(4);
    expect(result.material!.crls).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(ROOT_CRL_URL);

    await collectRevocationMaterial(pdf);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ดึง CRL ของ root ไม่ได้ / CRL ปลอม (ลงนามด้วย key อื่น) / ไม่มี CRL ของ CA ระบบ → ไม่ใส่ LTV พร้อมเหตุผล', async () => {
    const pdf = await signed();
    vi.spyOn(crlFetcher, 'fetch').mockRejectedValueOnce(new Error('ล่ม'));
    expect(await collectRevocationMaterial(pdf)).toMatchObject({ material: null, reason: expect.stringContaining('Test Root') });

    vi.spyOn(crlFetcher, 'fetch').mockResolvedValue(pki.forgedRootCrlPem);
    expect((await collectRevocationMaterial(pdf)).material).toBeNull();

    await pool.query('DELETE FROM crls');
    vi.spyOn(crlFetcher, 'fetch').mockResolvedValue(pki.rootCrlPem);
    expect(await collectRevocationMaterial(pdf)).toMatchObject({ material: null, reason: expect.stringContaining('Test Intermediate') });
  });
});

describe('appendDss + ตัวตรวจ', () => {
  it('DSS ต่อท้าย: ลายมือชื่อยังตรวจผ่าน และตัวตรวจระบุว่าที่ต่อท้ายเป็น LTV (ไม่ใช่การแก้ไข)', async () => {
    vi.spyOn(crlFetcher, 'fetch').mockResolvedValue(pki.rootCrlPem);
    const pdf = await signed();
    const { material } = await collectRevocationMaterial(pdf);
    const withDss = await appendDss(pdf, material!);
    expect(withDss.subarray(0, pdf.length).equals(pdf)).toBe(true);

    const [report] = (await verifyPdfSignatures(withDss)).signatures;
    expect(report).toMatchObject({ integrity: 'ok', coversWholeDocument: false, addedAfter: 'ltv' });
    expect(report!.findings.map((x) => x.message)).toContain('มีข้อมูลตรวจสอบระยะยาว (LTV) เพิ่มหลังลงนาม — ไม่ใช่การแก้ไขเอกสาร');
    const dss = (await PDFDocument.load(withDss)).catalog.lookup(PDFName.of('DSS'), PDFDict);
    expect(dss.has(PDFName.of('Certs')) && dss.has(PDFName.of('CRLs'))).toBe(true);
  });

  it('เอกสารที่ล็อก (P=1) แล้วถูกต่อท้าย (แม้เป็น DSS) → ตัวตรวจตัดสินว่าไม่ถูกต้อง แบบเดียวกับ Acrobat', async () => {
    vi.spyOn(crlFetcher, 'fetch').mockResolvedValue(pki.rootCrlPem);
    const pdf = await signed(true);
    const { material } = await collectRevocationMaterial(pdf);
    const [report] = (await verifyPdfSignatures(await appendDss(pdf, material!))).signatures;
    expect(report).toMatchObject({ integrity: 'ok', addedAfter: 'changes', verdict: 'invalid' });
  });

  it('ส่วนต่อท้ายที่มี DSS แต่แก้ catalog อย่างอื่นด้วย / เพิ่ม object นอก DSS → changes', async () => {
    const pdf = await signed();
    const update = async (change: (doc: PDFDocument) => void) => {
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      doc.getPages();
      const snapshot = snapshotObjects(doc);
      reserveExistingObjectNumbers(pdf, doc);
      doc.catalog.set(PDFName.of('DSS'), doc.context.register(doc.context.obj({ Certs: [] })));
      change(doc);
      return writeIncrementalUpdate(pdf, doc, snapshot);
    };
    const onlyDss = await update(() => {});
    expect((await verifyPdfSignatures(onlyDss)).signatures[0]!.addedAfter).toBe('ltv');

    const lang = await update((doc) => doc.catalog.set(PDFName.of('Lang'), PDFString.of('th')));
    expect((await verifyPdfSignatures(lang)).signatures[0]!.addedAfter).toBe('changes');

    const page = await update((doc) => doc.getPage(0).node.set(PDFName.of('Extra'), doc.context.register(doc.context.obj({}))));
    expect((await verifyPdfSignatures(page)).signatures[0]!.addedAfter).toBe('changes');
  });
});
