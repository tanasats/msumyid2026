import type { Metadata } from 'next';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { Alert } from '@/components/Alert';
import { buttonClasses } from '@/components/Button';
import { InfoList, InfoRow } from '@/components/InfoList';
import { PageShell } from '@/components/PageShell';
import { getCurrentUser } from '@/lib/auth';
import { ROOT_CA_FILE_NAME, getRootCa } from '@/lib/root-ca';

export const metadata: Metadata = { title: 'ติดตั้งใบรับรองหลัก (Root)' };

// TSA สาธารณะ (ใบรับรองอยู่ในรายชื่อที่ Acrobat เชื่อถือ) ใช้ระหว่างรอ TSA ของมหาวิทยาลัย — พร้อมแล้วเปลี่ยนเป็นของมหาวิทยาลัย
const TSA_URL = 'http://timestamp.digicert.com';

const dateFormatter =new Intl.DateTimeFormat('th-TH', { dateStyle: 'long' });

// วิธีติดตั้งใบรับรอง root ให้ Acrobat/Foxit เชื่อถือลายเซ็นที่ออกโดย CA ของมหาวิทยาลัย
// public: ผู้รับเอกสารที่ลงนามอาจไม่มีบัญชีในระบบ — login แล้วจะเห็นเมนูตามปกติ
export default async function RootCaPage() {
  const user = await getCurrentUser();
  const ca = getRootCa();

  return (
    <PageShell title="ติดตั้งใบรับรองหลัก (Root)" user={user ?? undefined} width="form">
      <div className="space-y-4">
        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">ทำไมต้องติดตั้ง</h2>
          <p className="mt-2 leading-relaxed text-muted">
            ใบรับรองของมหาวิทยาลัยมหาสารคามออกภายใต้ใบรับรองหลักของ {ca.organization} ซึ่ง Acrobat และ Foxit
            ยังไม่รู้จักโดยอัตโนมัติ ติดตั้งครั้งเดียวต่อเครื่อง แล้วลายเซ็นบนเอกสารจะแสดงว่า &ldquo;ถูกต้อง&rdquo;
            แทน &ldquo;ไม่ทราบความถูกต้อง&rdquo;
          </p>
          <a
            href={`/root-ca/${ROOT_CA_FILE_NAME}`}
            download
            className={`${buttonClasses({ fullWidth: true })} mt-5`}
          >
            <Download className="size-5" aria-hidden />
            ดาวน์โหลดใบรับรองหลัก (.cer)
          </a>
        </section>

        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">ข้อมูลใบรับรอง</h2>
          <p className="mt-1 text-sm text-muted">
            ตรวจว่าค่า SHA-256 ที่โปรแกรมแสดงตรงกับค่านี้ทุกตัวอักษรก่อนกดเชื่อถือ
          </p>
          <InfoList className="mt-4">
            <InfoRow label="ชื่อ">{ca.commonName}</InfoRow>
            <InfoRow label="องค์กร">{ca.organization}</InfoRow>
            <InfoRow label="ใช้ได้ถึง">
              <span className="tabular-nums">{dateFormatter.format(ca.validTo)}</span>
            </InfoRow>
            <InfoRow label="SHA-256">
              <span className="font-mono text-xs break-all">{ca.sha256}</span>
            </InfoRow>
            <InfoRow label="SHA-1">
              <span className="font-mono text-xs break-all">{ca.sha1}</span>
            </InfoRow>
          </InfoList>
        </section>

        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">Adobe Acrobat / Acrobat Reader</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>
              เปิดเมนู <strong className="font-semibold">Edit → Preferences</strong> (macOS: Acrobat → Settings) แล้วเลือก{' '}
              <strong className="font-semibold">Signatures</strong>
            </li>
            <li>
              ที่หัวข้อ Identities &amp; Trusted Certificates กด <strong className="font-semibold">More…</strong> แล้วเลือก{' '}
              <strong className="font-semibold">Trusted Certificates</strong>
            </li>
            <li>
              กด <strong className="font-semibold">Import</strong> → Browse เลือกไฟล์ <code className="font-mono text-sm">{ROOT_CA_FILE_NAME}</code> →
              กด Import
            </li>
            <li>
              เลือกใบ &ldquo;{ca.commonName}&rdquo; ในรายการ กด <strong className="font-semibold">Edit Trust</strong> แล้วติ๊ก
              <ul className="mt-1 list-disc pl-5">
                <li>Use this certificate as a trusted root</li>
                <li>Certified documents</li>
              </ul>
            </li>
            <li>กด OK แล้วปิดและเปิดเอกสารใหม่</li>
          </ol>
        </section>

        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">Foxit PDF Reader / Editor</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>
              เปิดเมนู <strong className="font-semibold">File → Preferences</strong> แล้วเลือก{' '}
              <strong className="font-semibold">Signature</strong>
            </li>
            <li>
              ที่หัวข้อ Trusted Certificates กด <strong className="font-semibold">Add</strong> แล้วเลือกไฟล์{' '}
              <code className="font-mono text-sm">{ROOT_CA_FILE_NAME}</code>
            </li>
            <li>กด OK แล้วปิดและเปิดเอกสารใหม่</li>
          </ol>
        </section>

        <section className="rounded-xl border border-line bg-surface shadow-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">ตั้งค่า Timestamp Server (สำหรับผู้ลงนาม)</h2>
          <p className="mt-2 leading-relaxed text-muted">
            ประทับเวลาที่เชื่อถือได้ลงในลายเซ็น ทำให้ลายเซ็นยังตรวจผ่านหลังใบรับรองหมดอายุหรือถูกเพิกถอน
            (ถ้าลงนามก่อนวันนั้น) และพิสูจน์ได้ว่าลงนามเมื่อไร — ไม่ตั้ง = ใช้เวลาจากนาฬิกาเครื่องผู้ลงนาม
            ระบบส่งไปเฉพาะค่า hash ของเอกสาร ไม่ส่งเนื้อหา
          </p>
          <InfoList className="mt-4">
            <InfoRow label="URL">
              <span className="font-mono text-sm break-all">{TSA_URL}</span>
            </InfoRow>
          </InfoList>

          <h3 className="mt-5 font-semibold">Adobe Acrobat / Acrobat Reader</h3>
          <ol className="mt-2 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>
              เปิด <strong className="font-semibold">Edit → Preferences → Signatures</strong> ที่หัวข้อ Document
              Timestamping กด <strong className="font-semibold">More…</strong>
            </li>
            <li>
              เลือก <strong className="font-semibold">Time Stamp Servers</strong> กด{' '}
              <strong className="font-semibold">New</strong> ใส่ชื่อ (เช่น TSA) และ URL ด้านบน แล้วกด OK
            </li>
            <li>
              เลือก server ที่เพิ่ม แล้วกด <strong className="font-semibold">Set Default</strong>
            </li>
          </ol>

          <h3 className="mt-5 font-semibold">Foxit PDF Reader / Editor</h3>
          <ol className="mt-2 list-decimal space-y-2 pl-5 leading-relaxed">
            <li>
              เปิด <strong className="font-semibold">File → Preferences → Time Stamp Servers</strong>
            </li>
            <li>
              กด <strong className="font-semibold">New</strong> ใส่ชื่อและ URL ด้านบน แล้วตั้งเป็น{' '}
              <strong className="font-semibold">Default</strong>
            </li>
          </ol>
        </section>

        <Alert tone="info" title="ชื่อเมนูอาจต่างกันเล็กน้อยตามรุ่นของโปรแกรม">
          ไม่ต้องติดตั้งใบรับรองของมหาวิทยาลัย (Intermediate) แยก เพราะแนบมากับลายเซ็นแล้ว
        </Alert>

        <p className="text-center text-sm text-muted">
          ไม่ต้องการติดตั้งโปรแกรม?{' '}
          <Link href="/verify" className="font-medium text-accent underline-offset-4 hover:underline">
            ตรวจสอบลายมือชื่อบนเว็บ
          </Link>
        </p>

        {!user && (
          <p className="text-center text-sm text-muted">
            ต้องการขอใบรับรอง?{' '}
            <Link href="/login" className="font-medium text-accent underline-offset-4 hover:underline">
              เข้าสู่ระบบ
            </Link>
          </p>
        )}
      </div>
    </PageShell>
  );
}
