'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { LogoutButton } from '@/components/LogoutButton';
import { ApiClientError, apiMutate } from '@/lib/api-client';
import { PRIVACY_NOTICE_VERSION } from './PrivacyNotice';

/**
 * ปุ่มรับทราบประกาศ — ส่งเวอร์ชันที่ผู้ใช้อ่านไปด้วย (API ปฏิเสธถ้าประกาศเปลี่ยนระหว่างเปิดหน้าค้างไว้)
 * เป็นการรับทราบ ไม่ใช่การให้ความยินยอม — ไม่รับทราบก็ออกจากระบบได้
 */
export function AcknowledgeForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function acknowledge() {
    setSubmitting(true);
    setError(undefined);
    try {
      await apiMutate('/me/privacy-acknowledgement', 'POST', { version: PRIVACY_NOTICE_VERSION });
      router.replace('/');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'PRIVACY_NOTICE_OUTDATED') {
        // ประกาศมีฉบับใหม่ → โหลดหน้าใหม่ให้อ่านฉบับล่าสุด
        setError(err.message);
        router.refresh();
      } else {
        setError(err instanceof ApiClientError ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
      }
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-labelledby="privacy-acknowledge"
      className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6"
    >
      <div>
        <h2 id="privacy-acknowledge" className="font-display text-lg font-semibold">
          รับทราบประกาศก่อนใช้งาน
        </h2>
        <p className="mt-1 text-sm text-muted">
          การกดรับทราบเป็นการยืนยันว่าท่านได้อ่านประกาศนี้แล้ว ไม่ใช่การให้ความยินยอม
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <div className="sm:w-48">
          <LogoutButton />
        </div>
        <Button fullWidth className="sm:w-48" loading={submitting} onClick={acknowledge}>
          {!submitting && <Check className="size-5" aria-hidden />}
          รับทราบ
        </Button>
      </div>
    </section>
  );
}
