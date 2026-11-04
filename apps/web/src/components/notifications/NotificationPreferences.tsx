'use client';

import { useState } from 'react';
import { Lock } from 'lucide-react';
import { apiMutate } from '@/lib/api-client';
import {
  NOTIFICATION_CATEGORY_LABELS,
  type NotificationCategory,
  type NotificationPreference,
} from '@/lib/notification';

type Channel = 'inApp' | 'email';

/** สวิตช์เปิด/ปิด — role="switch" + ป้ายบอกช่องทาง (พื้นที่แตะ 44px) */
function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange?: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className="flex min-h-11 min-w-11 items-center justify-center rounded-full disabled:cursor-not-allowed"
    >
      <span
        aria-hidden
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-line-input'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <span
          className={`absolute size-5 rounded-full bg-surface shadow transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

function Row({
  title,
  detail,
  children,
}: {
  title: React.ReactNode;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:w-44 sm:shrink-0">{children}</div>
    </div>
  );
}

function ChannelCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1 sm:justify-center">
      {children}
      {/* มือถือแสดงชื่อช่องทางข้างสวิตช์ — จอใหญ่มีหัวคอลัมน์แทน */}
      <span className="text-sm text-muted sm:hidden">{label}</span>
    </div>
  );
}

/**
 * ตั้งค่าการแจ้งเตือนต่อหมวด × ช่องทาง (docs/design/notifications.md) — บันทึกทันทีที่สลับ ไม่สำเร็จ = คืนค่าเดิมพร้อมข้อความ
 * หมวดความปลอดภัยปิดไม่ได้ แสดงไว้ให้รู้ว่ามีและเหตุผล
 */
export function NotificationPreferences({ initial }: { initial: NotificationPreference[] }) {
  const [preferences, setPreferences] = useState(initial);
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function change(category: NotificationCategory, channel: Channel, value: boolean) {
    const previous = preferences;
    const current = preferences.find((p) => p.category === category)!;
    const next = { ...current, [channel]: value };
    setPreferences(preferences.map((p) => (p.category === category ? next : p)));
    setSaving(category);
    setMessage(null);
    try {
      const { preferences: saved } = await apiMutate<{ preferences: NotificationPreference[] }>(
        '/me/notification-preferences',
        'PUT',
        { category, inApp: next.inApp, email: next.email },
      );
      setPreferences(saved);
      setMessage({ tone: 'ok', text: 'บันทึกแล้ว' });
    } catch (err) {
      setPreferences(previous);
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="mt-2">
      <div aria-hidden className="hidden justify-end gap-2 border-b border-line pb-2 text-sm font-medium text-muted sm:flex">
        <span className="w-[5.25rem] text-center">ในระบบ</span>
        <span className="w-[5.25rem] text-center">อีเมล</span>
      </div>
      <div className="divide-y divide-line">
        {preferences.map((p) => {
          const label = NOTIFICATION_CATEGORY_LABELS[p.category];
          return (
            <Row key={p.category} title={label.title} detail={label.detail}>
              <ChannelCell label="ในระบบ">
                {p.emailOnly ? (
                  <span className="flex min-h-11 min-w-11 items-center justify-center text-sm text-subtle">—</span>
                ) : (
                  <Switch
                    checked={p.inApp}
                    label={`${label.title} ในระบบ`}
                    disabled={saving === p.category}
                    onChange={(v) => void change(p.category, 'inApp', v)}
                  />
                )}
              </ChannelCell>
              <ChannelCell label="อีเมล">
                <Switch
                  checked={p.email}
                  label={`${label.title} ทางอีเมล`}
                  disabled={saving === p.category}
                  onChange={(v) => void change(p.category, 'email', v)}
                />
              </ChannelCell>
            </Row>
          );
        })}
        <Row
          title={
            <span className="flex items-center gap-1.5">
              ความปลอดภัยของใบรับรอง
              <Lock className="size-4 text-muted" aria-label="ปิดไม่ได้" />
            </span>
          }
          detail="ใบรับรองถูกเพิกถอนหรือถูกดาวน์โหลดใหม่ — ปิดไม่ได้ เพื่อให้คุณรู้ทันทีถ้ามีผู้อื่นเข้าบัญชีของคุณ"
        >
          <ChannelCell label="ในระบบ">
            <Switch checked label="ความปลอดภัยของใบรับรอง ในระบบ (ปิดไม่ได้)" disabled />
          </ChannelCell>
          <ChannelCell label="อีเมล">
            <Switch checked label="ความปลอดภัยของใบรับรอง ทางอีเมล (ปิดไม่ได้)" disabled />
          </ChannelCell>
        </Row>
      </div>
      <p
        aria-live="polite"
        className={`mt-2 min-h-5 text-sm ${message?.tone === 'error' ? 'text-danger-fg' : 'text-success-fg'}`}
      >
        {message?.text}
      </p>
    </div>
  );
}
