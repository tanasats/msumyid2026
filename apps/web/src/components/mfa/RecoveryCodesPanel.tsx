'use client';

import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { recoveryCodesText } from '@/lib/mfa';

/**
 * แสดงรหัสกู้คืน (ครั้งเดียว — ระบบเก็บแค่ hash) พร้อมปุ่มคัดลอก/ดาวน์โหลด
 * ต้องติ๊กว่าเก็บแล้วก่อนไปต่อ กันผู้ใช้ปิดหน้าโดยไม่ได้เก็บ
 */
export function RecoveryCodesPanel({
  codes,
  email,
  doneLabel,
  onDone,
}: {
  codes: string[];
  email: string;
  doneLabel: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = recoveryCodesText(codes, email);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      console.error(err);
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'msu-digital-id-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Alert tone="warning" title="เก็บรหัสกู้คืนไว้ตอนนี้">
        รหัสชุดนี้แสดงครั้งเดียว ใช้แทนรหัสจากแอปได้รหัสละครั้งเมื่อโทรศัพท์หาย — เก็บในที่ปลอดภัยแยกจากโทรศัพท์
      </Alert>
      <ol className="grid grid-cols-1 gap-2 rounded-xl border border-line bg-surface-hover p-4 font-mono text-base tracking-wider sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button variant="secondary" fullWidth onClick={copy}>
          <Copy className="size-5" aria-hidden />
          {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
        </Button>
        <Button variant="secondary" fullWidth onClick={download}>
          <Download className="size-5" aria-hidden />
          ดาวน์โหลด (.txt)
        </Button>
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3">
        <input type="checkbox" className="size-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>ฉันเก็บรหัสกู้คืนไว้แล้ว</span>
      </label>
      <Button fullWidth disabled={!saved} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
