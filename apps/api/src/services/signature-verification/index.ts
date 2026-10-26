import { createHash } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { findCertificateRevocationStatus } from '../../repositories/certificate-repository.js';
import { lockedNoChanges, onlyLtvAddedAfter } from './later-revisions.js';
import { extractPdfSignatures, type PdfSignature } from './pdf-signatures.js';
import {
  allowsDigitalSignature,
  allowsDocumentSigning,
  allowsTimestamping,
  asn1js,
  certificateSummary,
  fingerprintSha256,
  isWithinValidity,
  pkijs,
  sameCertificate,
  serialHex,
  toArrayBuffer,
} from './pki.js';
import { trustStore, type TrustAnchor, type TrustStore } from './trust-store.js';

// ตรวจลายมือชื่อดิจิทัลในไฟล์ PDF (หน้า /verify สาธารณะ) — ทำในหน่วยความจำทั้งหมด ไม่เก็บไฟล์
// ระดับผลเทียบกับแผงลายมือชื่อของ Acrobat: ถูกต้อง / ไม่ทราบความถูกต้อง / ไม่ถูกต้อง
// รายละเอียดการตัดสินใจ: docs/design/signature-verification.md

export type Verdict = 'valid' | 'unknown' | 'invalid';
export type Finding = { level: 'error' | 'warning' | 'info'; message: string };
export type CertificateSummary = ReturnType<typeof certificateSummary>;

export type SignatureReport = {
  index: number;
  /** signature = ลายมือชื่อของบุคคล, document_timestamp = การประทับเวลาทั้งเอกสาร (ETSI.RFC3161) */
  kind: 'signature' | 'document_timestamp';
  verdict: Verdict;
  findings: Finding[];
  name: string | null;
  reason: string | null;
  location: string | null;
  coversWholeDocument: boolean;
  /** สิ่งที่ต่อท้ายหลังลายมือชื่อนี้: none = ไม่มี, ltv = ข้อมูลตรวจสอบระยะยาว (DSS) ล้วน ไม่ใช่การแก้ไข, changes = อย่างอื่น (เช่น ลายมือชื่อถัดไป) */
  addedAfter: 'none' | 'ltv' | 'changes';
  /** ok = เอกสารไม่ถูกแก้ไขในช่วงที่ลงนาม และลายมือชื่อตรงกับใบรับรอง */
  integrity: 'ok' | 'failed' | 'unsupported';
  signer: CertificateSummary | null;
  chain: {
    status: 'trusted' | 'untrusted';
    anchor: string | null;
    path: { subject: string; issuer: string }[];
  };
  signingTime: { value: string | null; source: 'timestamp' | 'claimed' | 'none' };
  timestamp: { status: 'none' | 'valid' | 'untrusted' | 'invalid'; time: string | null; authority: string | null };
  revocation: {
    status: 'good' | 'revoked' | 'unknown';
    revokedAt: string | null;
    reason: string | null;
  };
  /** ใบรับรองออกโดย CA ของมหาวิทยาลัยมหาสารคาม */
  issuedByUniversity: boolean;
};

export type VerificationReport = {
  verifiedAt: string;
  signatures: SignatureReport[];
};

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_TIMESTAMP_TOKEN = '1.2.840.113549.1.9.16.2.14';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';

export async function verifyPdfSignatures(pdf: Buffer, now: Date = new Date()): Promise<VerificationReport> {
  const store = trustStore.get();
  const signatures = extractPdfSignatures(pdf);
  const reports: SignatureReport[] = [];
  for (const signature of signatures) {
    // ลายมือชื่อตัวสุดท้ายที่ไม่ครอบคลุมทั้งไฟล์: ดูว่าที่ต่อท้ายเป็น LTV ล้วนหรือไม่ (ตัวก่อนหน้ามีลายมือชื่อถัดไปต่อท้ายเสมอ)
    const end = signature.byteRange[2] + signature.byteRange[3];
    const addedAfter = signature.coversWholeDocument
      ? 'none'
      : signature.index === signatures.length - 1 && (await onlyLtvAddedAfter(pdf, end))
        ? 'ltv'
        : 'changes';
    const report = await verifySignature(signature, signatures.length, addedAfter, store, now);
    // เอกสารที่ล็อกแบบห้ามแก้ไข (DocMDP P=1): ต่อท้ายอะไรก็ตามหลังลายมือชื่อที่ล็อก (รวม DSS) = certification ไม่ถูกต้อง
    // ตรงกับ Acrobat (ทดสอบ 2026-10-26)
    if (!signature.coversWholeDocument && (await lockedNoChanges(pdf, signature))) {
      report.addedAfter = 'changes';
      report.findings.push({ level: 'error', message: 'เอกสารนี้ถูกล็อกห้ามแก้ไขไว้ แต่มีการเพิ่มเติมหลังลงนาม การรับรองเอกสารจึงไม่ถูกต้อง' });
      report.verdict = 'invalid';
    }
    reports.push(report);
  }
  return { verifiedAt: now.toISOString(), signatures: reports };
}

async function verifySignature(
  sig: PdfSignature,
  total: number,
  addedAfter: SignatureReport['addedAfter'],
  store: TrustStore,
  now: Date,
): Promise<SignatureReport> {
  const findings: Finding[] = [];
  const report: SignatureReport = {
    index: sig.index,
    kind: 'signature',
    verdict: 'unknown',
    findings,
    name: sig.name,
    reason: sig.reason,
    location: sig.location,
    coversWholeDocument: sig.coversWholeDocument,
    addedAfter,
    integrity: 'unsupported',
    signer: null,
    chain: { status: 'untrusted', anchor: null, path: [] },
    signingTime: { value: null, source: 'none' },
    timestamp: { status: 'none', time: null, authority: null },
    revocation: { status: 'unknown', revokedAt: null, reason: null },
    issuedByUniversity: false,
  };

  if (addedAfter === 'ltv') {
    findings.push({ level: 'info', message: 'มีข้อมูลตรวจสอบระยะยาว (LTV) เพิ่มหลังลงนาม — ไม่ใช่การแก้ไขเอกสาร' });
  } else if (!sig.coversWholeDocument) {
    const later = total - 1 - sig.index;
    findings.push({
      level: 'warning',
      message:
        later > 0
          ? 'เอกสารมีการเพิ่มเติมหลังลายมือชื่อนี้ (เช่น ลายมือชื่อถัดไป) — ส่วนที่ลงนามไว้ไม่ถูกแก้ไข'
          : 'เอกสารถูกแก้ไขหรือเพิ่มเติมหลังลงนาม — ส่วนที่ลงนามไว้ไม่ถูกแก้ไข แต่ส่วนที่เพิ่มภายหลังไม่ได้รับการรับรอง',
    });
  }

  if (sig.subFilter === 'adbe.x509.rsa_sha1') {
    findings.push({ level: 'warning', message: 'ลายมือชื่อรูปแบบเก่า (adbe.x509.rsa_sha1) ระบบยังไม่รองรับการตรวจ' });
    return report;
  }

  let signedData: pkijs.SignedData;
  try {
    const contentInfo = pkijs.ContentInfo.fromBER(toArrayBuffer(sig.cms));
    if (contentInfo.contentType !== OID_SIGNED_DATA) throw new Error('not SignedData');
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
    normalizeEContent(signedData);
  } catch {
    report.integrity = 'failed';
    report.verdict = 'invalid';
    findings.push({ level: 'error', message: 'ข้อมูลลายมือชื่อเสียหายหรือไม่ใช่รูปแบบ CMS' });
    return report;
  }

  if (signedData.encapContentInfo.eContentType === OID_TST_INFO) {
    return verifyDocumentTimestamp(report, signedData, sig, store);
  }

  // 1. ความครบถ้วน: hash ตรงกับ messageDigest และลายมือชื่อตรงกับ public key ของผู้ลงนาม
  const integrity = await checkIntegrity(signedData, sig);
  report.integrity = integrity.status;
  if (integrity.message) findings.push({ level: integrity.status === 'failed' ? 'error' : 'warning', message: integrity.message });
  const signer = integrity.signer;
  if (!signer) {
    report.verdict = integrity.status === 'failed' ? 'invalid' : 'unknown';
    return report;
  }
  report.signer = certificateSummary(signer);

  // 2. เวลาลงนาม: เชื่อเฉพาะเวลาจากหน่วยประทับเวลาที่ตรวจผ่าน
  const signerInfo = signedData.signerInfos[0]!;
  const claimedTime = signingTimeAttribute(signerInfo) ?? sig.claimedTime;
  const timestamp = await checkEmbeddedTimestamp(signerInfo, store);
  report.timestamp = {
    status: timestamp.status,
    time: timestamp.time?.toISOString() ?? null,
    authority: timestamp.authority,
  };
  if (timestamp.message) findings.push({ level: 'warning', message: timestamp.message });
  const trustedTime = timestamp.status === 'valid' ? timestamp.time : null;
  report.signingTime = trustedTime
    ? { value: trustedTime.toISOString(), source: 'timestamp' }
    : claimedTime
      ? { value: claimedTime.toISOString(), source: 'claimed' }
      : { value: null, source: 'none' };

  // 3. สายใบรับรองถึง root ที่เชื่อถือ — แยก "ถึง root ได้ไหม" ออกจาก "ใบยังไม่หมดอายุ ณ เวลาลงนาม"
  const evaluationTime = trustedTime ?? now;
  const extraCerts = [...embeddedCertificates(signedData), ...store.intermediates];
  let chain = await validateChain(signer, extraCerts, store.signerAnchors, evaluationTime);
  let validAtSigningTime = chain.ok;
  if (!chain.ok) {
    const probe = claimedTime && isWithinValidity(signer, claimedTime) ? claimedTime : midpoint(signer);
    chain = await validateChain(signer, extraCerts, store.signerAnchors, probe);
    validAtSigningTime = false;
  }
  report.chain = {
    status: chain.ok ? 'trusted' : 'untrusted',
    anchor: chain.anchor?.name ?? null,
    path: chain.path.map((c) => ({ subject: certificateSummary(c).subject, issuer: certificateSummary(c).issuer })),
  };
  report.issuedByUniversity = chain.ok && chain.path.length > 1 && sameCertificate(chain.path[1]!, store.msuIssuer);

  // 4. การเพิกถอน
  if (chain.ok) {
    report.revocation = await checkRevocation(signer, report.issuedByUniversity, trustedTime, findings);
  }

  report.verdict = decideVerdict(report, {
    validAtSigningTime,
    hasTrustedTime: trustedTime !== null,
    keyUsageOk: allowsDocumentSigning(signer) && allowsDigitalSignature(signer),
    findings,
  });
  return report;
}

function decideVerdict(
  report: SignatureReport,
  ctx: { validAtSigningTime: boolean; hasTrustedTime: boolean; keyUsageOk: boolean; findings: Finding[] },
): Verdict {
  const { findings } = ctx;
  if (report.integrity === 'failed') return 'invalid';
  if (report.integrity === 'unsupported') return 'unknown';
  if (report.chain.status !== 'trusted') {
    findings.push({
      level: 'warning',
      message: 'ใบรับรองของผู้ลงนามไม่ได้ออกภายใต้ CA ที่ระบบเชื่อถือ จึงยืนยันตัวตนผู้ลงนามไม่ได้',
    });
    return 'unknown';
  }
  if (report.revocation.status === 'revoked') return 'invalid';
  if (!ctx.validAtSigningTime) {
    if (ctx.hasTrustedTime) {
      findings.push({ level: 'error', message: 'ใบรับรองหมดอายุหรือยังไม่เริ่มใช้ ณ เวลาที่ประทับ' });
      return 'invalid';
    }
    findings.push({
      level: 'warning',
      message: 'ใบรับรองหมดอายุแล้ว และลายมือชื่อไม่มีการประทับเวลา จึงยืนยันไม่ได้ว่าลงนามขณะใบรับรองยังใช้งานได้',
    });
    return 'unknown';
  }
  if (!ctx.keyUsageOk) {
    findings.push({ level: 'warning', message: 'ใบรับรองไม่ได้กำหนดให้ใช้ลงนามเอกสาร' });
    return 'unknown';
  }
  if (report.revocation.status === 'unknown') return 'unknown';
  return 'valid';
}

type IntegrityResult = {
  status: SignatureReport['integrity'];
  signer: pkijs.Certificate | null;
  message: string | null;
};

async function checkIntegrity(signedData: pkijs.SignedData, sig: PdfSignature): Promise<IntegrityResult> {
  try {
    const result = await signedData.verify({
      signer: 0,
      data: toArrayBuffer(sig.signedData),
      checkChain: false,
      extendedMode: true,
    });
    const signer = result.signerCertificate ?? null;
    if (!result.signatureVerified) {
      return { status: 'failed', signer, message: 'ลายมือชื่อไม่ตรงกับใบรับรองของผู้ลงนาม' };
    }
    // adbe.pkcs7.sha1: ลายมือชื่อครอบ SHA-1 ของเอกสารที่ฝังไว้ใน eContent — ต้องเทียบกับ hash จริงของเอกสารเอง
    const eContent = signedData.encapContentInfo.eContent;
    if (eContent) {
      const embedded = Buffer.from(eContent.getValue());
      const actual = createHash('sha1').update(sig.signedData).digest();
      if (!embedded.equals(actual)) {
        return { status: 'failed', signer, message: 'เอกสารถูกแก้ไขหลังลงนาม (ค่า hash ไม่ตรงกัน)' };
      }
    }
    return { status: 'ok', signer, message: null };
  } catch (error) {
    if (error instanceof pkijs.SignedDataVerifyError) {
      const signer = error.signerCertificate ?? null;
      switch (error.code) {
        case 2:
        case 3:
          return { status: 'unsupported', signer: null, message: 'ไม่พบใบรับรองของผู้ลงนามในลายมือชื่อ' };
        case 7:
          return { status: 'unsupported', signer, message: 'ลายมือชื่อใช้อัลกอริทึมที่ระบบยังไม่รองรับ' };
        default:
          return {
            status: 'failed',
            signer,
            message: /digest/i.test(error.message)
              ? 'เอกสารถูกแก้ไขหลังลงนาม (ค่า hash ไม่ตรงกัน)'
              : 'ลายมือชื่อไม่ถูกต้อง',
          };
      }
    }
    // error อื่น (เช่น อัลกอริทึมที่ WebCrypto ไม่รองรับ) ถือว่าตรวจไม่ได้ ไม่ใช่ปลอม
    return { status: 'unsupported', signer: null, message: 'ระบบตรวจลายมือชื่อนี้ไม่ได้ (รูปแบบหรืออัลกอริทึมไม่รองรับ)' };
  }
}

/**
 * eContent ที่เข้ารหัสเป็น OCTET STRING แบบ constructed (BER แบ่งเป็นท่อน — TSA บางรายและ pkijs เองสร้างแบบนี้)
 * pkijs ตอนตรวจอ่านได้เฉพาะแบบ primitive จึงแปลงก่อน — ปลอดภัยเพราะลายมือชื่อครอบ messageDigest ของค่าข้างใน ไม่ใช่รูปแบบการเข้ารหัส
 */
function normalizeEContent(signedData: pkijs.SignedData): void {
  const eContent = signedData.encapContentInfo.eContent;
  if (eContent?.idBlock.isConstructed) {
    signedData.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: eContent.getValue() });
  }
}

function embeddedCertificates(signedData: pkijs.SignedData): pkijs.Certificate[] {
  return (signedData.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
}

function signingTimeAttribute(signerInfo: pkijs.SignerInfo): Date | null {
  const attribute = signerInfo.signedAttrs?.attributes.find((a) => a.type === OID_SIGNING_TIME);
  const value = attribute?.values[0] as { toDate?: () => Date } | undefined;
  return value?.toDate ? value.toDate() : null;
}

function midpoint(certificate: pkijs.Certificate): Date {
  const from = certificate.notBefore.value.getTime();
  const to = certificate.notAfter.value.getTime();
  return new Date(from + (to - from) / 2);
}

type ChainResult = { ok: boolean; path: pkijs.Certificate[]; anchor: TrustAnchor | null };

async function validateChain(
  leaf: pkijs.Certificate,
  extraCerts: pkijs.Certificate[],
  anchors: TrustAnchor[],
  checkDate: Date,
): Promise<ChainResult> {
  const engine = new pkijs.CertificateChainValidationEngine({
    trustedCerts: anchors.map((a) => a.certificate),
    // ใบสุดท้ายของ certs คือใบปลายทาง (ข้อกำหนดของ pkijs)
    certs: [...extraCerts.filter((c) => !sameCertificate(c, leaf)), leaf],
    checkDate,
  });
  try {
    const result = await engine.verify();
    const path = result.certificatePath ?? [];
    if (!result.result || path.length === 0) return { ok: false, path: [], anchor: null };
    const root = path[path.length - 1]!;
    const anchor = anchors.find((a) => sameCertificate(a.certificate, root)) ?? null;
    return { ok: anchor !== null, path, anchor };
  } catch {
    // สร้างสายไม่ได้ (ไม่พบผู้ออกใบ, ลายมือชื่อบนใบไม่ถูกต้อง ฯลฯ) = ไม่ถึง root ที่เชื่อถือ
    return { ok: false, path: [], anchor: null };
  }
}

async function checkRevocation(
  signer: pkijs.Certificate,
  issuedByUniversity: boolean,
  trustedTime: Date | null,
  findings: Finding[],
): Promise<SignatureReport['revocation']> {
  if (!issuedByUniversity) {
    findings.push({
      level: 'info',
      message: 'ระบบยังตรวจการเพิกถอนได้เฉพาะใบรับรองของมหาวิทยาลัยมหาสารคาม',
    });
    return { status: 'unknown', revokedAt: null, reason: null };
  }

  // ใบของ มมส. ตรวจจากตาราง certificates โดยตรง (ข้อมูลล่าสุด เป็นต้นทางของ CRL)
  const row = await findCertificateRevocationStatus(pool, serialHex(signer));
  if (!row) {
    findings.push({ level: 'warning', message: 'ไม่พบใบรับรองนี้ในระบบของมหาวิทยาลัย จึงตรวจการเพิกถอนไม่ได้' });
    return { status: 'unknown', revokedAt: null, reason: null };
  }
  if (row.fingerprintSha256 !== fingerprintSha256(signer)) {
    findings.push({ level: 'error', message: 'ใบรับรองไม่ตรงกับข้อมูลในระบบของมหาวิทยาลัย' });
    return { status: 'unknown', revokedAt: null, reason: null };
  }
  if (!row.revokedAt) return { status: 'good', revokedAt: null, reason: null };

  const revoked = { revokedAt: row.revokedAt.toISOString(), reason: row.revocationReason };
  // เพิกถอนหลังเวลาที่ประทับ = ลงนามขณะใบยังใช้ได้ ลายมือชื่อยังถูกต้อง
  if (trustedTime && row.revokedAt > trustedTime) {
    findings.push({ level: 'info', message: 'ใบรับรองถูกเพิกถอนภายหลัง แต่การประทับเวลายืนยันว่าลงนามก่อนเพิกถอน' });
    return { status: 'good', ...revoked };
  }
  findings.push({ level: 'error', message: 'ใบรับรองของผู้ลงนามถูกเพิกถอนแล้ว' });
  return { status: 'revoked', ...revoked };
}

type TimestampResult = {
  status: SignatureReport['timestamp']['status'];
  time: Date | null;
  authority: string | null;
  signer: pkijs.Certificate | null;
  chain: ChainResult | null;
  message: string | null;
};

/** ตรวจ timestamp token (RFC 3161): ลายมือชื่อของ TSA, messageImprint ตรงกับ data และสายใบของ TSA ถึง root ที่เชื่อถือ */
async function checkTimestampToken(
  token: pkijs.SignedData,
  data: ArrayBuffer,
  store: TrustStore,
): Promise<TimestampResult> {
  normalizeEContent(token);
  let genTime: Date;
  let signer: pkijs.Certificate;
  try {
    const result = await token.verify({ signer: 0, data, checkChain: false, extendedMode: true });
    if (!result.signatureVerified || !result.date || !result.signerCertificate) {
      return {
        status: 'invalid',
        time: result.date ?? null,
        authority: null,
        signer: result.signerCertificate ?? null,
        chain: null,
        message: 'การประทับเวลาไม่ถูกต้อง',
      };
    }
    genTime = result.date;
    signer = result.signerCertificate;
  } catch {
    return { status: 'invalid', time: null, authority: null, signer: null, chain: null, message: 'การประทับเวลาไม่ถูกต้อง' };
  }

  const authority = certificateSummary(signer).commonName ?? certificateSummary(signer).subject;
  const chain = await validateChain(
    signer,
    [...embeddedCertificates(token), ...store.intermediates],
    store.timestampAnchors,
    genTime,
  );
  if (!chain.ok || !allowsTimestamping(signer)) {
    return {
      status: 'untrusted',
      time: genTime,
      authority,
      signer,
      chain,
      message: 'หน่วยประทับเวลาไม่อยู่ในรายชื่อที่ระบบเชื่อถือ จึงไม่ใช้เวลาที่ประทับ',
    };
  }
  return { status: 'valid', time: genTime, authority, signer, chain, message: null };
}

async function checkEmbeddedTimestamp(signerInfo: pkijs.SignerInfo, store: TrustStore): Promise<TimestampResult> {
  const attribute = signerInfo.unsignedAttrs?.attributes.find((a) => a.type === OID_TIMESTAMP_TOKEN);
  if (!attribute) {
    return { status: 'none', time: null, authority: null, signer: null, chain: null, message: null };
  }
  try {
    const contentInfo = new pkijs.ContentInfo({ schema: attribute.values[0] });
    const token = new pkijs.SignedData({ schema: contentInfo.content });
    // timestamp ของลายมือชื่อประทับบนค่าลายมือชื่อ (signature value) ตาม RFC 3161 / PAdES
    const data = toArrayBuffer(signerInfo.signature.valueBlock.valueHexView);
    return await checkTimestampToken(token, data, store);
  } catch {
    return { status: 'invalid', time: null, authority: null, signer: null, chain: null, message: 'การประทับเวลาเสียหาย' };
  }
}

async function verifyDocumentTimestamp(
  report: SignatureReport,
  token: pkijs.SignedData,
  sig: PdfSignature,
  store: TrustStore,
): Promise<SignatureReport> {
  report.kind = 'document_timestamp';
  const result = await checkTimestampToken(token, toArrayBuffer(sig.signedData), store);
  report.integrity = result.status === 'invalid' ? 'failed' : 'ok';
  report.signer = result.signer ? certificateSummary(result.signer) : null;
  report.timestamp = { status: result.status, time: result.time?.toISOString() ?? null, authority: result.authority };
  report.signingTime =
    result.status === 'valid' && result.time
      ? { value: result.time.toISOString(), source: 'timestamp' }
      : { value: null, source: 'none' };
  if (result.chain?.ok) {
    report.chain = {
      status: 'trusted',
      anchor: result.chain.anchor?.name ?? null,
      path: result.chain.path.map((c) => ({ subject: certificateSummary(c).subject, issuer: certificateSummary(c).issuer })),
    };
  }
  if (result.message) report.findings.push({ level: result.status === 'invalid' ? 'error' : 'warning', message: result.message });
  report.verdict = result.status === 'valid' ? 'valid' : result.status === 'invalid' ? 'invalid' : 'unknown';
  return report;
}
