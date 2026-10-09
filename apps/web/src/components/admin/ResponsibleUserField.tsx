'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/Button';
import type { ResponsibleUser } from '@/lib/account-type';
import { apiGet } from '@/lib/api-client';

// ค้นหาหลังหยุดพิมพ์ช่วงสั้น ๆ เพื่อไม่ยิง API ทุกตัวอักษร
const SEARCH_DELAY_MS = 300;
const MIN_QUERY_LENGTH = 2;

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; users: ResponsibleUser[] }
  | { status: 'error'; message: string };

/**
 * ช่องเลือกผู้รับผิดชอบบัญชีหน่วยงาน — ค้นหาบุคลากรที่ใช้งานได้จาก GET /admin/users (ต้องมี user:read)
 * API ตรวจซ้ำตอนบันทึกเสมอว่าเป็นบุคลากรที่ใช้งานได้
 */
export function ResponsibleUserField({
  value,
  onChange,
  error,
}: {
  value: ResponsibleUser | null;
  onChange: (user: ResponsibleUser | null) => void;
  error?: string;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<SearchState>({ status: 'idle' });
  const trimmed = query.trim();

  useEffect(() => {
    if (value || trimmed.length < MIN_QUERY_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearch({ status: 'loading' });
      try {
        const params = new URLSearchParams({ q: trimmed, accountType: 'staff', status: 'active' });
        const { users } = await apiGet<{ users: ResponsibleUser[] }>(`/admin/users?${params}`, controller.signal);
        setSearch({ status: 'done', users });
      } catch (err) {
        if (controller.signal.aborted) return;
        setSearch({ status: 'error', message: err instanceof Error ? err.message : 'ค้นหาไม่สำเร็จ' });
      }
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, value]);

  const hintId = 'field-responsible-hint';
  const errorId = error ? 'field-responsible-error' : undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor="field-responsible" className="block text-sm font-medium text-fg">
        ผู้รับผิดชอบ
      </label>

      {value ? (
        <div className="flex items-center gap-3 rounded-lg border border-line-input bg-surface p-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{value.displayName}</p>
            <p className="truncate text-sm text-muted">{value.email}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onChange(null);
              setQuery('');
              setSearch({ status: 'idle' });
            }}
          >
            เปลี่ยน
          </Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-subtle" aria-hidden />
            <input
              id="field-responsible"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อหรืออีเมลบุคลากร"
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              aria-describedby={errorId ?? hintId}
              className={`block h-12 w-full rounded-lg border bg-surface pr-3 pl-10 text-base text-fg placeholder:text-subtle ${
                error ? 'border-danger' : 'border-line-input'
              }`}
            />
          </div>

          {trimmed.length >= MIN_QUERY_LENGTH && (
            <div aria-live="polite">
              {search.status === 'loading' && <p className="text-sm text-muted">กำลังค้นหา...</p>}
              {search.status === 'error' && <p className="text-sm text-danger-fg">{search.message}</p>}
              {search.status === 'done' &&
                (search.users.length === 0 ? (
                  <p className="text-sm text-muted">ไม่พบบุคลากรที่ตรงกับ &quot;{trimmed}&quot;</p>
                ) : (
                  <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
                    {search.users.map((user) => (
                      <li key={user.id}>
                        <button
                          type="button"
                          onClick={() => onChange({ id: user.id, displayName: user.displayName, email: user.email })}
                          className="flex min-h-12 w-full flex-col items-start justify-center px-3 py-2 text-left hover:bg-surface-hover"
                        >
                          <span className="font-medium">{user.displayName}</span>
                          <span className="text-sm break-all text-muted">{user.email}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ))}
            </div>
          )}
        </>
      )}

      {error ? (
        <p id={errorId} className="text-sm text-danger-fg">
          {error}
        </p>
      ) : (
        <p id={hintId} className="text-sm text-muted">
          บุคลากรที่รับผิดชอบการใช้งานบัญชีนี้ (ต้องมีบัญชีในระบบและใช้งานได้)
        </p>
      )}
    </div>
  );
}
