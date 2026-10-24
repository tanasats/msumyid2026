import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfSigningError, signPdf, TimestampError } from '../src/services/pdf-signing/index.js';
import type { TsaTransport } from '../src/services/pdf-signing/timestamp.js';
import { verifyPdfSignatures } from '../src/services/signature-verification/index.js';
import { signer } from '../src/services/signer-client.js';

// เครื่องมือลงนาม PDF (ระยะ D0): ใช้ OpenSSL จริงแทน signer (key ทดสอบ) และ TSA จำลองด้วย openssl ts
// แล้วตรวจผลด้วยตัวตรวจเดียวกับหน้า /verify — ไม่เรียก signer และ MSU TSA จริง

let dir: string;
const file = (name: string) => path.join(dir, name);
const openssl = (args: string[], input?: Buffer) => execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
/** OpenSSL 3.2+ มี cms -cades (runner ของ GitHub เป็น 3.0) — แบบเดียวกับ supportsCmsCades ของ signer */
const cadesFlag = (() => {
  const help = spawnSync('openssl', ['cms', '-help'], { encoding: 'utf8' });
  return `${help.stdout}${help.stderr}`.includes('-cades') ? ['-cades'] : [];
})();

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'msumyid-pdf-signing-'));
  // ผู้ลงนาม (self-signed) และ TSA (EKU timeStamping แบบ critical ตาม RFC 3161)
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('signer.key'), '-out', file('signer.pem'), '-days', '2', '-subj', '/CN=Test Signer']);
  writeFileSync(
    file('tsa-ext.cnf'),
    ['[ ext ]', 'basicConstraints = CA:FALSE', 'keyUsage = critical, digitalSignature', 'extendedKeyUsage = critical, timeStamping', ''].join('\n'),
  );
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', file('tsa.key'), '-out', file('tsa.pem'), '-days', '2', '-subj', '/CN=Test TSA', '-config', file('tsa-ext.cnf'), '-extensions', 'ext', '-section', 'ext']);
  writeFileSync(file('tsaserial'), '01\n');
  writeFileSync(
    file('ts.cnf'),
    [
      '[ tsa ]',
      'default_tsa = tsa_config',
      '[ tsa_config ]',
      `serial = ${file('tsaserial').replaceAll('\\', '/')}`,
      'default_policy = 1.2.3.4.1',
      'signer_digest = sha256',
      'digests = sha256',
      'accuracy = secs:1',
      'ess_cert_id_alg = sha256',
      'ess_cert_id_chain = no',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** signer ทดสอบ: openssl cms -sign -cades แบบเดียวกับ apps/signer */
function mockSigner() {
  return vi.spyOn(signer, 'signCms').mockImplementation(async ({ content }) => {
    writeFileSync(file('content.bin'), content);
    openssl(['cms', '-sign', '-binary', '-in', file('content.bin'), '-signer', file('signer.pem'), '-inkey', file('signer.key'), '-md', 'sha256', ...cadesFlag, '-nosmimecap', '-outform', 'DER', '-out', file('sig.der')]);
    return readFileSync(file('sig.der'));
  });
}

/** TSA จำลอง: ตอบคำขอจริงด้วย openssl ts -reply */
const fakeTsa: TsaTransport = async (query) => {
  writeFileSync(file('req.tsq'), query);
  openssl(['ts', '-reply', '-queryfile', file('req.tsq'), '-signer', file('tsa.pem'), '-inkey', file('tsa.key'), '-config', file('ts.cnf'), '-out', file('resp.tsr')]);
  return readFileSync(file('resp.tsr'));
};

const certificate = { serialNumber: '1', certificatePem: '-----BEGIN CERTIFICATE-----', escrow: { kekId: 't', encryptedKey: Buffer.alloc(1), wrappedDataKey: Buffer.alloc(1) } };

async function samplePdf(pages = 2, options: { classicTrailer?: boolean } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 780, font, size: 14 });
  // classicTrailer = เขียน xref แบบตาราง + trailer (ไม่ใช่ xref stream) ให้แก้ trailer ด้วยข้อความได้
  return Buffer.from(await doc.save({ useObjectStreams: !options.classicTrailer }));
}

const sign = (pdf: Buffer, options: { lock?: boolean; tsa?: TsaTransport } = {}) =>
  signPdf(pdf, { certificate, signerName: 'ผู้ลงนาม ทดสอบ', lock: options.lock ?? false, tsaTransport: options.tsa ?? fakeTsa });

describe('signPdf', () => {
  it('ลงนามแล้ว: ตัวตรวจของ /verify เห็นลายมือชื่อเดียว เอกสารไม่ถูกแก้ ครอบคลุมทั้งไฟล์ และเวลามาจาก timestamp', async () => {
    const send = mockSigner();
    const { pdf, timestampTime } = await sign(await samplePdf());

    expect(send).toHaveBeenCalledOnce();
    // signer ได้เฉพาะข้อมูลตาม ByteRange + ข้อมูลใบ ไม่ได้ทั้งไฟล์
    expect(send.mock.calls[0]![0].content.length).toBeLessThan(pdf.length);

    const report = await verifyPdfSignatures(pdf);
    expect(report.signatures).toHaveLength(1);
    const [s] = report.signatures;
    expect(s).toMatchObject({ kind: 'signature', integrity: 'ok', coversWholeDocument: true, name: 'ผู้ลงนาม ทดสอบ' });
    // มี timestamp และอ่านเวลาได้ตรงกับที่ TSA ตอบ — TSA จำลองไม่ได้ต่อสายถึง CA ที่ระบบเชื่อถือ ตัวตรวจจึงยังใช้เวลาที่อ้าง (/M)
    // (กับ MSU TSA จริง ตัวตรวจได้ timestamp.status = valid และ signingTime.source = timestamp — สคริปต์ pdf:sign-sample)
    expect(s!.timestamp.status).toBe('untrusted');
    expect(s!.timestamp.time).toBe(timestampTime.toISOString());

    // เปิดด้วย pdf-lib ได้ จำนวนหน้าเท่าเดิม และไม่มีการล็อก
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.catalog.get(PDFName.of('Perms'))).toBeUndefined();
  });

  it('ล็อกเอกสาร: มี /Perms /DocMDP (P=1) และแก้ไขต่อท้ายหลังลงนาม → ตัวตรวจเห็นว่าลายมือชื่อไม่ครอบคลุมทั้งไฟล์', async () => {
    mockSigner();
    const { pdf } = await sign(await samplePdf(), { lock: true });
    const doc = await PDFDocument.load(pdf);
    const perms = doc.catalog.lookup(PDFName.of('Perms'), PDFDict);
    const signature = perms.lookup(PDFName.of('DocMDP'), PDFDict);
    expect(signature.get(PDFName.of('Reference'))).toBeDefined();
    expect((await verifyPdfSignatures(pdf)).signatures[0]).toMatchObject({ integrity: 'ok', coversWholeDocument: true });

    // แก้ไขแบบต่อท้ายไฟล์ (incremental update) หลังลงนาม
    const tampered = Buffer.concat([pdf, Buffer.from('\n1 0 obj\n<< /Tampered true >>\nendobj\n%%EOF\n')]);
    expect((await verifyPdfSignatures(tampered)).signatures[0]!.coversWholeDocument).toBe(false);
  });

  it('TSA ล่ม → TimestampError (ไม่ออกไฟล์ที่ไม่มีเวลา)', async () => {
    mockSigner();
    const down: TsaTransport = async () => {
      throw new TimestampError('เรียกบริการประทับเวลาไม่สำเร็จ');
    };
    await expect(sign(await samplePdf(), { tsa: down })).rejects.toBeInstanceOf(TimestampError);
  });

  it('TSA ตอบคำขออื่น (nonce/hash ไม่ตรง) หรือตอบไม่ใช่ timestamp → TimestampError', async () => {
    mockSigner();
    // ตอบด้วยคำตอบของคำขอเดิมที่บันทึกไว้ (replay)
    let recorded: Buffer | null = null;
    const recorder: TsaTransport = async (query) => (recorded = await fakeTsa(query));
    await sign(await samplePdf(), { tsa: recorder });
    const replay: TsaTransport = async () => recorded!;
    await expect(sign(await samplePdf(), { tsa: replay })).rejects.toThrow(/ไม่ตรง/);

    const garbage: TsaTransport = async () => Buffer.from('<html>error</html>');
    await expect(sign(await samplePdf(), { tsa: garbage })).rejects.toBeInstanceOf(TimestampError);
  });

  it('ไม่ใช่ PDF / มีลายมือชื่ออยู่แล้ว / เข้ารหัส → PdfSigningError ตามเหตุผล และไม่เรียก signer', async () => {
    const send = mockSigner();
    const reject = async (pdf: Buffer) => {
      const err = await sign(pdf).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PdfSigningError);
      return (err as PdfSigningError).code;
    };
    expect(await reject(Buffer.from('not a pdf'))).toBe('NOT_PDF');

    const { pdf: signed } = await sign(await samplePdf());
    send.mockClear();
    expect(await reject(signed)).toBe('ALREADY_SIGNED');

    // trailer ที่มี /Encrypt = ไฟล์ตั้งรหัสผ่าน/จำกัดสิทธิ์
    const classic = (await samplePdf(1, { classicTrailer: true })).toString('latin1');
    expect(classic).toContain('trailer');
    const encrypted = Buffer.from(classic.replace(/trailer\s*<</, 'trailer\n<<\n/Encrypt << /Filter /Standard /V 1 >>'), 'latin1');
    expect(await reject(encrypted)).toBe('ENCRYPTED');
    expect(send).not.toHaveBeenCalled();
  });
});
