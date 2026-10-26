import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TsaTransport } from '../../src/services/pdf-signing/timestamp.js';

// PKI ทดสอบครบสาย (ระยะ D4b): root → intermediate → ผู้ลงนาม + TSA พร้อม CRL ของทั้ง 2 CA — สร้างด้วย OpenSSL จริง
// intermediate มี CDP ชี้ไป ROOT_CRL_URL (test แทนการดึงด้วย crlFetcher) ส่วน CRL ของ intermediate ใส่ในตาราง crls (เหมือน CA ของระบบ)

export const ROOT_CRL_URL = 'http://crl.test.invalid/root.crl';

const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
const cadesFlag = (() => {
  const help = spawnSync('openssl', ['cms', '-help'], { encoding: 'utf8' });
  return `${help.stdout}${help.stderr}`.includes('-cades') ? ['-cades'] : [];
})();

export type TestPki = {
  /** CMS แบบ detached ด้วยใบผู้ลงนาม แนบ intermediate ในสายใบ (แบบเดียวกับ signer จริง) */
  signCms: (content: Buffer) => Buffer;
  tsa: TsaTransport;
  rootCertPem: string;
  /** CRL ของ intermediate (DER) — ใส่ในตาราง crls */
  intermediateCrlDer: Buffer;
  /** CRL ของ root (PEM แบบที่ cdp.kku.ac.th เผยแพร่) */
  rootCrlPem: Buffer;
  /** CRL ปลอม: ชื่อผู้ออกเป็น root แต่ลงนามด้วย key อื่น */
  forgedRootCrlPem: Buffer;
  cleanup: () => void;
};

export function createTestPki(): TestPki {
  const dir = mkdtempSync(path.join(tmpdir(), 'msumyid-test-pki-'));
  const f = (name: string) => path.join(dir, name).replaceAll('\\', '/');
  writeFileSync(
    f('ext.cnf'),
    [
      '[ root ]',
      'basicConstraints = critical, CA:TRUE',
      'keyUsage = critical, keyCertSign, cRLSign',
      '[ intermediate ]',
      'basicConstraints = critical, CA:TRUE, pathlen:0',
      'keyUsage = critical, keyCertSign, cRLSign',
      `crlDistributionPoints = URI:${ROOT_CRL_URL}`,
      '[ signer ]',
      'basicConstraints = CA:FALSE',
      'keyUsage = critical, digitalSignature, nonRepudiation',
      '[ tsa ]',
      'basicConstraints = CA:FALSE',
      'keyUsage = critical, digitalSignature',
      'extendedKeyUsage = critical, timeStamping',
      '',
    ].join('\n'),
  );
  const req = (name: string, cn: string) =>
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', f(`${name}.key`), '-out', f(`${name}.csr`), '-subj', `/C=TH/O=Test/CN=${cn}`]);
  const issue = (name: string, ca: string, section: string) =>
    openssl(['x509', '-req', '-in', f(`${name}.csr`), '-CA', f(`${ca}.pem`), '-CAkey', f(`${ca}.key`), '-CAcreateserial', '-days', '30', '-sha256', '-extfile', f('ext.cnf'), '-extensions', section, '-out', f(`${name}.pem`)]);

  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('root.key'), '-out', f('root.pem'), '-days', '30', '-subj', '/C=TH/O=Test/CN=Test Root', '-config', f('ext.cnf'), '-extensions', 'root', '-section', 'root']);
  req('intermediate', 'Test Intermediate');
  issue('intermediate', 'root', 'intermediate');
  req('signer', 'Test Signer');
  issue('signer', 'intermediate', 'signer');
  req('tsa', 'Test TSA');
  issue('tsa', 'intermediate', 'tsa');
  req('forger', 'Test Root');
  openssl(['x509', '-req', '-in', f('forger.csr'), '-signkey', f('forger.key'), '-days', '30', '-out', f('forger.pem')]);

  // CRL: openssl ca -gencrl ต้องมี config + ฐานข้อมูล (ว่าง = ไม่มีใบถูกเพิกถอน)
  const crl = (ca: string, cert: string, out: string) => {
    writeFileSync(f(`${ca}-index.txt`), '');
    writeFileSync(f(`${ca}-crlnumber`), '1000\n');
    writeFileSync(
      f(`${ca}-ca.cnf`),
      ['[ ca ]', 'default_ca = test', '[ test ]', `database = ${f(`${ca}-index.txt`)}`, `crlnumber = ${f(`${ca}-crlnumber`)}`, `certificate = ${f(cert)}`, `private_key = ${f(`${ca}.key`)}`, 'default_md = sha256', 'default_crl_days = 30', ''].join('\n'),
    );
    openssl(['ca', '-config', f(`${ca}-ca.cnf`), '-gencrl', '-out', f(out)]);
  };
  crl('intermediate', 'intermediate.pem', 'intermediate.crl');
  crl('root', 'root.pem', 'root.crl');
  crl('forger', 'forger.pem', 'forged.crl');

  writeFileSync(
    f('ts.cnf'),
    ['[ tsa ]', 'default_tsa = tsa_config', '[ tsa_config ]', `serial = ${f('tsaserial')}`, 'default_policy = 1.2.3.4.1', 'signer_digest = sha256', 'digests = sha256', 'accuracy = secs:1', 'ess_cert_id_alg = sha256', 'ess_cert_id_chain = no', `certs = ${f('intermediate.pem')}`, ''].join('\n'),
  );
  writeFileSync(f('tsaserial'), '01\n');

  return {
    signCms: (content) => {
      writeFileSync(f('content.bin'), content);
      openssl(['cms', '-sign', '-binary', '-in', f('content.bin'), '-signer', f('signer.pem'), '-inkey', f('signer.key'), '-certfile', f('intermediate.pem'), '-md', 'sha256', ...cadesFlag, '-nosmimecap', '-outform', 'DER', '-out', f('sig.der')]);
      return readFileSync(f('sig.der'));
    },
    tsa: async (query) => {
      writeFileSync(f('req.tsq'), query);
      openssl(['ts', '-reply', '-queryfile', f('req.tsq'), '-signer', f('tsa.pem'), '-inkey', f('tsa.key'), '-config', f('ts.cnf'), '-out', f('resp.tsr')]);
      return readFileSync(f('resp.tsr'));
    },
    rootCertPem: readFileSync(f('root.pem'), 'utf8'),
    intermediateCrlDer: execFileSync('openssl', ['crl', '-in', f('intermediate.crl'), '-outform', 'DER']),
    rootCrlPem: readFileSync(f('root.crl')),
    forgedRootCrlPem: readFileSync(f('forged.crl')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
