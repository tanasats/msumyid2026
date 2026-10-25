'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/Button';
import { ApiClientError, downloadMyFile } from '@/lib/api-client';

/** ดาวน์โหลดไฟล์ที่ลงนามแล้ว (ขอ URL อายุ 5 นาทีทุกครั้งที่กด) */
export function DownloadButton({ fileId, size = 'md', label = 'ดาวน์โหลด' }: { fileId: string; size?: 'md' | 'sm'; label?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex flex-col items-stretch gap-1 sm:items-end">
      <Button
        size={size}
        fullWidth
        variant={size === 'sm' ? 'secondary' : 'primary'}
        loading={loading}
        onClick={async () => {
          setLoading(true);
          setError(null);
          try {
            await downloadMyFile(fileId);
          } catch (err) {
            setError(err instanceof ApiClientError ? err.message : 'ดาวน์โหลดไม่สำเร็จ กรุณาลองใหม่');
          } finally {
            setLoading(false);
          }
        }}
      >
        <Download className="size-5" aria-hidden />
        {label}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-danger-fg">
          {error}
        </span>
      )}
    </span>
  );
}
