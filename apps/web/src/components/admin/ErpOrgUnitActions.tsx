'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { History, Link2, RotateCcw } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { apiGet, apiMutate } from '@/lib/api-client';
import {
  describeMappingSide,
  type ErpOrgUnitItem,
  type ErpOrgUnitMappingLog,
  type OrgUnitOption,
} from '@/lib/erp-org-unit';

const dateTimeFormatter = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

const numberFormatter = new Intl.NumberFormat('th-TH');

/** ข้อความหลังบันทึก — บอกผลกับบุคลากรเสมอ (0 คน = ยังไม่มีใครในหน่วยงานนี้ หรือค่าเดิมตรงอยู่แล้ว) */
const affectedText = (n: number) =>
  n === 0 ? 'ไม่มีบุคลากรที่หน่วยงานเปลี่ยน' : `เปลี่ยนหน่วยงานของบุคลากร ${numberFormatter.format(n)} คนแล้ว`;

/**
 * ปุ่มของหน่วยงาน ERP หนึ่งแถว: จับคู่/เปลี่ยน, คืนให้ระบบจับคู่ (เฉพาะที่กำหนดเอง), ดูประวัติ
 * API ตรวจสิทธิ์ org_unit:manage และขอยืนยันตัวตนซ้ำ (apiMutate เปิด StepUpDialog ให้เอง)
 */
export function ErpOrgUnitActions({ item, orgUnits }: { item: ErpOrgUnitItem; orgUnits: OrgUnitOption[] }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'set' | 'reset' | null>(null);
  const [orgUnitId, setOrgUnitId] = useState(item.orgUnit?.id ?? '');
  const [result, setResult] = useState<string | null>(null);
  const [logs, setLogs] = useState<ErpOrgUnitMappingLog[] | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  function openSet() {
    setOrgUnitId(item.orgUnit?.id ?? '');
    setDialog('set');
  }

  async function confirmSet(reason: string) {
    if (!orgUnitId) throw new Error('กรุณาเลือกหน่วยงาน');
    const res = await apiMutate<{ affectedUsers: number }>(`/admin/erp-org-units/${item.id}/mapping`, 'PUT', {
      orgUnitId,
      reason,
    });
    setResult(affectedText(res.affectedUsers));
    setLogs(null);
    router.refresh();
  }

  async function confirmReset(reason: string) {
    const res = await apiMutate<{ affectedUsers: number; matched: boolean }>(
      `/admin/erp-org-units/${item.id}/mapping`,
      'DELETE',
      { reason },
    );
    setResult(`${res.matched ? 'ระบบจับคู่จากชื่อได้' : 'ชื่อไม่ตรงกับหน่วยงานใด จึงยังไม่จับคู่'} — ${affectedText(res.affectedUsers)}`);
    setLogs(null);
    router.refresh();
  }

  async function toggleLogs() {
    const next = !logsOpen;
    setLogsOpen(next);
    if (!next || logs) return;
    setLogsError(null);
    try {
      setLogs((await apiGet<{ logs: ErpOrgUnitMappingLog[] }>(`/admin/erp-org-units/${item.id}/logs`)).logs);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'โหลดประวัติไม่สำเร็จ');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={item.orgUnit ? 'secondary' : 'primary'} onClick={openSet}>
          <Link2 className="size-4" aria-hidden />
          {item.orgUnit ? 'เปลี่ยน' : 'จับคู่'}
        </Button>
        {item.matchType === 'manual' && (
          <Button size="sm" variant="secondary" onClick={() => setDialog('reset')}>
            <RotateCcw className="size-4" aria-hidden />
            คืนให้ระบบจับคู่
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={toggleLogs} aria-expanded={logsOpen}>
          <History className="size-4" aria-hidden />
          ประวัติ
        </Button>
      </div>

      {result && (
        <div role="status">
          <Alert tone="success">{result}</Alert>
        </div>
      )}

      {logsOpen && (
        <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
          {logsError ? (
            <Alert tone="danger">{logsError}</Alert>
          ) : !logs ? (
            <p className="text-muted">กำลังโหลดประวัติ…</p>
          ) : logs.length === 0 ? (
            <p className="text-muted">ยังไม่มีการเปลี่ยนโดยผู้ดูแล</p>
          ) : (
            <ol className="space-y-3">
              {logs.map((log) => (
                <li key={log.id}>
                  <p>
                    <span className="font-medium">{log.actor?.displayName ?? 'ผู้ใช้ที่ถูกลบแล้ว'}</span>
                    <span className="text-muted"> · {dateTimeFormatter.format(new Date(log.createdAt))}</span>
                  </p>
                  <p className="text-muted">
                    {describeMappingSide(log.from)} → {describeMappingSide(log.to)} · บุคลากร{' '}
                    {numberFormatter.format(log.affectedUsers)} คน
                  </p>
                  <p className="text-muted">เหตุผล: {log.reason}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <ConfirmDialog
        open={dialog === 'set'}
        onClose={() => setDialog(null)}
        title={item.orgUnit ? 'เปลี่ยนหน่วยงานที่จับคู่หรือไม่?' : 'จับคู่หน่วยงานนี้หรือไม่?'}
        description={
          <>
            <span className="font-medium text-fg">{item.nameTh}</span> ({item.erpCode}) — บุคลากรที่ ERP ระบุว่าอยู่หน่วยงานนี้{' '}
            {numberFormatter.format(item.staffCount)} คนจะได้หน่วยงานใหม่ทันที (ยกเว้นคนที่กอง/ฝ่ายจับคู่ไว้แล้ว)
            ระบบจะไม่เปลี่ยนการจับคู่นี้เองเมื่อบุคลากรเข้าสู่ระบบ
          </>
        }
        confirmLabel="บันทึกการจับคู่"
        reason="required"
        reasonHint="บันทึกไว้ในประวัติการจับคู่ของหน่วยงานนี้"
        confirmDisabled={!orgUnitId}
        onConfirm={confirmSet}
      >
        <div className="space-y-1.5">
          <label htmlFor={`org-unit-${item.id}`} className="block text-sm font-medium">
            หน่วยงานในระบบ
          </label>
          <select
            id={`org-unit-${item.id}`}
            value={orgUnitId}
            onChange={(e) => setOrgUnitId(e.target.value)}
            className="block h-12 w-full rounded-lg border border-line-input bg-surface px-3 text-base"
          >
            <option value="" disabled>
              เลือกหน่วยงาน
            </option>
            {orgUnits.map((o) => (
              <option key={o.id} value={o.id}>
                {o.nameTh} ({o.code})
              </option>
            ))}
          </select>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'reset'}
        onClose={() => setDialog(null)}
        title="คืนให้ระบบจับคู่จากชื่อหรือไม่?"
        description="ระบบจะจับคู่จากชื่อที่ตรงกันพอดี ถ้าไม่ตรงกับหน่วยงานใด บุคลากรในหน่วยงานนี้จะไม่มีหน่วยงาน (หรือใช้ของคณะ/สำนัก) จนกว่าจะจับคู่ใหม่"
        confirmLabel="คืนให้ระบบจับคู่"
        reason="required"
        reasonHint="บันทึกไว้ในประวัติการจับคู่ของหน่วยงานนี้"
        onConfirm={confirmReset}
      />
    </div>
  );
}
