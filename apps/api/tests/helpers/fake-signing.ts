import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi, type MockInstance } from 'vitest';
import type { TsaTransport } from '../../src/services/pdf-signing/timestamp.js';
import { signer } from '../../src/services/signer-client.js';

// signer และ TSA จำลองด้วย OpenSSL จริง (key ทดสอบ) สำหรับ test ที่ลงนาม PDF — ไม่เรียก signer และ MSU TSA จริง

const openssl = (args: string[], input?: Buffer) => execFileSync('openssl', args, { input, stdio: ['pipe', 'pipe', 'pipe'] });
/** OpenSSL 3.2+ มี cms -cades (runner ของ GitHub เป็น 3.0) — แบบเดียวกับ supportsCmsCades ของ signer */
const cadesFlag = (() => {
  const help = spawnSync('openssl', ['cms', '-help'], { encoding: 'utf8' });
  return `${help.stdout}${help.stderr}`.includes('-cades') ? ['-cades'] : [];
})();

export type FakeSigning = {
  /** แทน signer.signCms ด้วย openssl cms -sign -cades แบบเดียวกับ apps/signer */
  mockSigner: () => MockInstance<typeof signer.signCms>;
  /** TSA จำลอง: ตอบคำขอจริงด้วย openssl ts -reply */
  fakeTsa: TsaTransport;
  cleanup: () => void;
};

/** สร้างผู้ลงนาม (self-signed) และ TSA (EKU timeStamping แบบ critical ตาม RFC 3161) ในโฟลเดอร์ชั่วคราว */
export function createFakeSigning(): FakeSigning {
  const dir = mkdtempSync(path.join(tmpdir(), 'msumyid-pdf-signing-'));
  const file = (name: string) => path.join(dir, name);

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

  return {
    mockSigner: () =>
      vi.spyOn(signer, 'signCms').mockImplementation(async ({ content }) => {
        writeFileSync(file('content.bin'), content);
        openssl(['cms', '-sign', '-binary', '-in', file('content.bin'), '-signer', file('signer.pem'), '-inkey', file('signer.key'), '-md', 'sha256', ...cadesFlag, '-nosmimecap', '-outform', 'DER', '-out', file('sig.der')]);
        return readFileSync(file('sig.der'));
      }),
    fakeTsa: async (query) => {
      writeFileSync(file('req.tsq'), query);
      openssl(['ts', '-reply', '-queryfile', file('req.tsq'), '-signer', file('tsa.pem'), '-inkey', file('tsa.key'), '-config', file('ts.cnf'), '-out', file('resp.tsr')]);
      return readFileSync(file('resp.tsr'));
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
