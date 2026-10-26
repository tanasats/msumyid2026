import http from 'node:http';
import https from 'node:https';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { logger } from '../middlewares/logger.js';
import { findLatestCrl } from '../repositories/crl-repository.js';
import type { RevocationMaterial } from './pdf-signing/ltv.js';
import { extractPdfSignatures } from './signature-verification/pdf-signatures.js';
import { asn1js, certificateDer, formatName, pkijs, toArrayBuffer } from './signature-verification/pki.js';
import { trustStore } from './signature-verification/trust-store.js';

// รวบรวมข้อมูลตรวจสอบระยะยาว (LTV, ระยะ D4b) ของลายมือชื่อล่าสุดในไฟล์: ใบรับรองในสายใบของผู้ลงนามและของ TSA
// + CRL ของ CA ทุกใบที่ออกใบในสาย — CA ของระบบใช้ CRL ล่าสุดในฐานข้อมูล, CA อื่น (TUC) ดึงจาก URL ในใบ (CDP) แล้ว cache จนหมดอายุ
// ได้ไม่ครบ = ไม่ใส่ LTV (ยืนยัน 2026-10-26: ลงนามต่อได้ และแจ้งในผล) — ไม่ใส่บางส่วน เพราะโปรแกรมอ่าน PDF ต้องมีครบทั้งสาย

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_CRL_DISTRIBUTION_POINTS = '2.5.29.31';
/** CRL ที่ใหญ่ผิดปกติไม่ฝังในเอกสาร (CRL ของ มมส./TUC ไม่กี่ KB) */
const MAX_CRL_BYTES = 2 * 1024 * 1024;

export type LtvResult = { material: RevocationMaterial } | { material: null; reason: string };

const MAX_REDIRECTS = 3;

/**
 * ดาวน์โหลด CRL (http/https, ตาม redirect ไม่เกิน 3 ครั้ง) — ไม่ตรวจใบ TLS: ความน่าเชื่อถือของ CRL มาจากลายมือชื่อของ CA บน CRL
 * ซึ่งตรวจกับใบของผู้ออกทุกครั้ง (usableCrl) เหมือนที่ CDP ทั่วไปเผยแพร่ผ่าน http
 * (cdp.msu.ac.th redirect ไป https ที่ไม่ส่งใบ intermediate ของ TLS มาด้วย — fetch ของ Node ปฏิเสธ)
 */
function download(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(target, { rejectUnauthorized: false, timeout: config.crl.fetchTimeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('redirect มากเกินไป'));
        const next = new URL(res.headers.location, target).toString();
        if (!/^https?:\/\//i.test(next)) return reject(new Error('redirect ไป URL ที่ไม่รองรับ'));
        return download(next, redirects + 1).then(resolve, reject);
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${status}`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_CRL_BYTES) req.destroy(new Error('CRL ใหญ่ผิดปกติ'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('หมดเวลาดึง CRL')));
    req.on('error', reject);
  });
}

/** ดึง CRL จาก URL — แยกเป็น object ให้ test แทนได้ */
export const crlFetcher = { fetch: (url: string): Promise<Buffer> => download(url) };

type CachedCrl = { der: Buffer; nextUpdate: Date };
const fetchedCrls = new Map<string, CachedCrl>();

/** ล้าง cache (ใช้ใน test) */
export function clearCrlCache(): void {
  fetchedCrls.clear();
}

const nameKey = (name: pkijs.RelativeDistinguishedNames) => formatName(name);
const isSelfSigned = (c: pkijs.Certificate) => nameKey(c.subject) === nameKey(c.issuer);

/** CRL แบบ PEM (เช่น ที่ cdp.kku.ac.th เผยแพร่) หรือ DER → DER */
function crlToDer(body: Buffer): Buffer {
  const text = body.toString('latin1');
  const pem = /-----BEGIN X509 CRL-----([\s\S]+?)-----END X509 CRL-----/.exec(text);
  return pem ? Buffer.from(pem[1]!.replace(/\s+/g, ''), 'base64') : body;
}

function parseCrl(der: Buffer): pkijs.CertificateRevocationList {
  const asn1 = asn1js.fromBER(toArrayBuffer(der));
  if (asn1.offset === -1) throw new Error('CRL เสีย');
  return new pkijs.CertificateRevocationList({ schema: asn1.result });
}

function cdpUrls(certificate: pkijs.Certificate): string[] {
  const ext = certificate.extensions?.find((e) => e.extnID === OID_CRL_DISTRIBUTION_POINTS)?.parsedValue;
  if (!(ext instanceof pkijs.CRLDistributionPoints)) return [];
  return ext.distributionPoints.flatMap((point) => {
    const names = Array.isArray(point.distributionPoint) ? point.distributionPoint : [];
    // type 6 = uniformResourceIdentifier — รับเฉพาะ http(s)
    return names.filter((n) => n.type === 6 && /^https?:\/\//i.test(String(n.value))).map((n) => String(n.value));
  });
}

/** CRL ที่ใช้ได้ตอนนี้: ออกโดยผู้ออกใบ (ชื่อตรงและลายมือชื่อบน CRL ตรวจผ่านกับใบของผู้ออก) และยังไม่ถึง nextUpdate */
async function usableCrl(der: Buffer, issuer: pkijs.Certificate, now: Date): Promise<CachedCrl | null> {
  let crl: pkijs.CertificateRevocationList;
  try {
    crl = parseCrl(der);
  } catch {
    return null;
  }
  const nextUpdate = crl.nextUpdate?.value;
  if (nameKey(crl.issuer) !== nameKey(issuer.subject) || !nextUpdate || nextUpdate <= now) return null;
  const signed = await crl.verify({ issuerCertificate: issuer }).catch(() => false);
  return signed ? { der, nextUpdate } : null;
}

/**
 * CRL ของ issuer ของใบนี้ — CRL ที่ส่งมาเพิ่ม (สคริปต์ทดสอบ/test) ก่อน, แล้ว CA ของระบบใช้ฉบับล่าสุดในฐานข้อมูล
 * ไม่เช่นนั้นดึงจาก CDP ของใบ (cache จนหมดอายุ)
 */
async function crlFor(
  certificate: pkijs.Certificate,
  issuer: pkijs.Certificate,
  now: Date,
  extraCrls: Buffer[],
): Promise<Buffer | null> {
  for (const der of extraCrls) {
    const extra = await usableCrl(der, issuer, now);
    if (extra) return extra.der;
  }
  const latest = await findLatestCrl(pool);
  if (latest) {
    const own = await usableCrl(latest.crlDer, issuer, now);
    if (own) return own.der;
  }
  for (const url of cdpUrls(certificate)) {
    const cached = fetchedCrls.get(url);
    if (cached && cached.nextUpdate > now) return cached.der;
    try {
      const fresh = await usableCrl(crlToDer(await crlFetcher.fetch(url)), issuer, now);
      if (fresh) {
        fetchedCrls.set(url, fresh);
        return fresh.der;
      }
    } catch (err) {
      logger.warn({ err, url }, 'ดึง CRL สำหรับ LTV ไม่สำเร็จ');
    }
  }
  return null;
}

/** สายใบจากใบปลายทางขึ้นไปจนถึง root (จับคู่ issuer กับ subject จากใบที่มีอยู่) */
function chainOf(leaf: pkijs.Certificate, pool: pkijs.Certificate[]): pkijs.Certificate[] {
  const chain = [leaf];
  for (let current = leaf; !isSelfSigned(current) && chain.length < 10; ) {
    const issuer = pool.find((c) => nameKey(c.subject) === nameKey(current.issuer));
    if (!issuer) break;
    chain.push(issuer);
    current = issuer;
  }
  return chain;
}

function signedDataOf(der: ArrayBuffer | Uint8Array): pkijs.SignedData {
  const asn1 = asn1js.fromBER(der instanceof Uint8Array ? toArrayBuffer(der) : der);
  const info = new pkijs.ContentInfo({ schema: asn1.result });
  if (info.contentType !== OID_SIGNED_DATA) throw new Error('ไม่ใช่ SignedData');
  return new pkijs.SignedData({ schema: info.content });
}

const certificatesOf = (sd: pkijs.SignedData) =>
  (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);

/** ใบที่ลงนาม SignerInfo แรก (จับคู่ issuer + serial) */
function signerCertificate(sd: pkijs.SignedData): pkijs.Certificate | null {
  const sid = sd.signerInfos[0]?.sid;
  if (!(sid instanceof pkijs.IssuerAndSerialNumber)) return null;
  return (
    certificatesOf(sd).find((c) => nameKey(c.issuer) === nameKey(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber)) ?? null
  );
}

/**
 * ใบรับรองและ CRL ของลายมือชื่อล่าสุดในไฟล์ (ลายมือชื่อที่ระบบเพิ่งลงนาม):
 * สายใบของผู้ลงนาม + สายใบของ TSA ใน timestamp token — ทุกใบที่ไม่ใช่ root ต้องมี CRL ของผู้ออกใบ
 */
export async function collectRevocationMaterial(
  pdf: Buffer,
  options: { now?: Date; /** CRL เพิ่มเติม (DER/PEM) — สคริปต์ทดสอบบนเครื่อง dev ที่ root ปลอมไม่มี CDP */ extraCrls?: Buffer[] } = {},
): Promise<LtvResult> {
  const now = options.now ?? new Date();
  const extraCrls = (options.extraCrls ?? []).map(crlToDer);
  const signature = extractPdfSignatures(pdf).at(-1);
  if (!signature) return { material: null, reason: 'ไม่พบลายมือชื่อ' };

  const sd = signedDataOf(signature.cms);
  const store = trustStore.get();
  const known = [...store.intermediates, ...store.signerAnchors.map((a) => a.certificate), ...store.timestampAnchors.map((a) => a.certificate)];
  const leaves: { leaf: pkijs.Certificate | null; certs: pkijs.Certificate[] }[] = [
    { leaf: signerCertificate(sd), certs: certificatesOf(sd) },
  ];
  const tokenAttr = sd.signerInfos[0]?.unsignedAttrs?.attributes.find((a) => a.type === OID_TIMESTAMP_TOKEN);
  if (tokenAttr) {
    const token = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: tokenAttr.values[0] }).content });
    leaves.push({ leaf: signerCertificate(token), certs: certificatesOf(token) });
  }

  const certs = new Map<string, Buffer>();
  const crls = new Map<string, Buffer>();
  for (const { leaf, certs: embedded } of leaves) {
    if (!leaf) return { material: null, reason: 'ไม่พบใบรับรองของผู้ลงนาม/TSA ในลายมือชื่อ' };
    const chain = chainOf(leaf, [...embedded, ...known]);
    if (!isSelfSigned(chain.at(-1)!)) return { material: null, reason: `ต่อสายใบไม่ถึง root: ${nameKey(chain.at(-1)!.issuer)}` };
    for (const [i, certificate] of chain.entries()) {
      const der = certificateDer(certificate);
      certs.set(der.toString('base64'), der);
      if (isSelfSigned(certificate)) continue;
      const crl = await crlFor(certificate, chain[i + 1]!, now, extraCrls);
      if (!crl) return { material: null, reason: `ไม่มี CRL ของ ${nameKey(certificate.issuer)}` };
      crls.set(crl.toString('base64'), crl);
    }
  }
  return { material: { certs: [...certs.values()], crls: [...crls.values()] } };
}
