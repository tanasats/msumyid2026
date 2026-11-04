'use client';

import { useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ApiClientError, apiMutate } from '@/lib/api-client';
import { formatSecret, type MfaSetup, type RecoveryCodes } from '@/lib/mfa';
import { MfaCodeForm } from './MfaCodeForm';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

type Step = { kind: 'start' } | { kind: 'scan'; setup: MfaSetup; qr: string } | { kind: 'codes'; codes: string[] };

/**
 * ตั้งค่า MFA 3 ขั้น: เริ่ม (สุ่ม secret ที่ API) → สแกน QR แล้วใส่รหัสแรก → เก็บรหัสกู้คืน
 * QR สร้างใน browser (ไลบรารี qrcode) — secret ไม่ถูกส่งไปบริการภายนอก
 */
export function MfaSetupWizard({ email, doneHref }: { email: string; doneHref: string }) {
  const [step, setStep] = useState<Step>({ kind: 'start' });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function start() {
    setStarting(true);
    setError(undefined);
    try {
      const setup = await apiMutate<MfaSetup>('/me/mfa/totp/setup', 'POST');
      const qr = await QRCode.toDataURL(setup.otpauthUri, { margin: 2, width: 240, errorCorrectionLevel: 'M' });
      setStep({ kind: 'scan', setup, qr });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'เริ่มตั้งค่าไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setStarting(false);
    }
  }

  async function confirm(code: string) {
    const result = await apiMutate<RecoveryCodes>('/me/mfa/totp/confirm', 'POST', { code });
    setStep({ kind: 'codes', codes: result.recoveryCodes });
  }

  if (step.kind === 'codes') {
    return (
      <RecoveryCodesPanel
        codes={step.codes}
        email={email}
        doneLabel="เสร็จสิ้น"
        // โหลดหน้าใหม่ทั้งหมด: สถานะ MFA ของ session เปลี่ยนแล้ว (เมนู/สิทธิ์ที่ซ่อนไว้ต้องคำนวณใหม่)
        onDone={() => window.location.assign(doneHref)}
      />
    );
  }

  if (step.kind === 'scan') {
    return (
      <div className="space-y-6">
        <ol className="list-decimal space-y-2 pl-5 leading-relaxed">
          <li>เปิดแอป Authenticator (เช่น Google Authenticator, Microsoft Authenticator) แล้วเลือกเพิ่มบัญชี</li>
          <li>สแกน QR code ด้านล่าง หรือพิมพ์รหัสตั้งค่าเอง</li>
          <li>ใส่รหัส 6 หลักที่แอปแสดง</li>
        </ol>
        <div className="flex flex-col items-center gap-3">
          {/* data URL ที่สร้างใน browser — ภาพมีพื้นขาวและขอบในตัว (margin) จึงสแกนได้ทั้งโหมดสว่างและมืด */}
          <img
            src={step.qr}
            alt="QR code สำหรับเพิ่มบัญชีในแอป Authenticator"
            width={240}
            height={240}
            className="rounded-lg"
          />
          <div className="text-center">
            <p className="text-sm text-muted">รหัสตั้งค่า (ถ้าสแกนไม่ได้)</p>
            <p className="mt-1 font-mono text-base tracking-wider break-all select-all">{formatSecret(step.setup.secret)}</p>
          </div>
        </div>
        <MfaCodeForm name="mfa-setup" submitLabel="ยืนยันและเปิดใช้งาน" allowRecoveryCode={false} onSubmit={confirm} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="leading-relaxed">
        นอกจากบัญชี Google แล้ว ระบบจะขอรหัส 6 หลักจากแอป Authenticator ในโทรศัพท์ของคุณทุกครั้งที่เข้าสู่ระบบ
        และก่อนทำรายการสำคัญ เช่น ดาวน์โหลดใบรับรอง — แม้บัญชี Google ถูกขโมย ผู้อื่นก็เข้าระบบแทนคุณไม่ได้
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button fullWidth loading={starting} onClick={start}>
        {!starting && <Smartphone className="size-5" aria-hidden />}
        เริ่มตั้งค่า
      </Button>
    </div>
  );
}
