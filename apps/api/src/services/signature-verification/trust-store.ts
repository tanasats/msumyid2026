import { rootCertificates } from 'node:tls';
import { displayName, parseCertificatePem, type pkijs } from './pki.js';
import { MSU_INTERMEDIATE_PEM, TUC_ROOT_PEM } from './university-ca.js';

export type TrustAnchor = { name: string; certificate: pkijs.Certificate };

export type TrustStore = {
  /** root ที่เชื่อถือสำหรับใบของผู้ลงนาม (ระยะ V1: TUC เท่านั้น — CA สาธารณะเพิ่มในระยะ V2) */
  signerAnchors: TrustAnchor[];
  /** root ที่เชื่อถือสำหรับหน่วยประทับเวลา (TSA): TUC + root สาธารณะที่มากับ Node (Mozilla) */
  timestampAnchors: TrustAnchor[];
  /** ใบกลางที่ระบบรู้จัก ใช้ต่อสายใบเมื่อเอกสารไม่ได้แนบมา */
  intermediates: pkijs.Certificate[];
  /** Intermediate ของ มมส. — ใบที่ออกโดยใบนี้ตรวจการเพิกถอนจากตาราง certificates ได้โดยตรง */
  msuIssuer: pkijs.Certificate;
};

let cached: TrustStore | null = null;

function load(): TrustStore {
  const tucRoot: TrustAnchor = {
    name: 'Thai University Consortium Certification Authority',
    certificate: parseCertificatePem(TUC_ROOT_PEM),
  };
  const msuIssuer = parseCertificatePem(MSU_INTERMEDIATE_PEM);
  const publicRoots: TrustAnchor[] = [];
  for (const pem of rootCertificates) {
    try {
      const certificate = parseCertificatePem(pem);
      publicRoots.push({ name: displayName(certificate.subject), certificate });
    } catch {
      // root บางใบที่ pkijs แยกไม่ได้ ข้ามไป (มีผลแค่ TSA ของ CA นั้นตรวจไม่ผ่าน ไม่ทำให้ระบบล้ม)
    }
  }
  return {
    signerAnchors: [tucRoot],
    timestampAnchors: [tucRoot, ...publicRoots],
    intermediates: [msuIssuer],
    msuIssuer,
  };
}

// แยกเป็น object เพื่อให้ test แทนที่ trust store ด้วย CA ปลอมได้ (vi.spyOn(trustStore, 'get'))
export const trustStore = {
  get(): TrustStore {
    cached ??= load();
    return cached;
  },
};
