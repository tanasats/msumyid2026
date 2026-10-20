import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '@/components/PageShell';
import { PdfVerifier } from '@/components/verify/PdfVerifier';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'ตรวจสอบลายมือชื่อบนเอกสาร' };

// public: ผู้รับเอกสารที่ลงนามส่วนใหญ่ไม่มีบัญชีในระบบ — login แล้วจะเห็นเมนูตามปกติ
export default async function VerifyPage() {
  const user = await getCurrentUser();

  return (
    <PageShell title="ตรวจสอบลายมือชื่อบนเอกสาร" user={user ?? undefined} width="form">
      <div className="space-y-6">
        <p className="leading-relaxed text-muted">
          อัปโหลดไฟล์ PDF ที่ลงนามด้วยลายมือชื่อดิจิทัล ระบบจะตรวจว่าเอกสารไม่ถูกแก้ไขหลังลงนาม ใบรับรองของผู้ลงนามออกโดยหน่วยงานที่เชื่อถือได้
          และยังไม่ถูกเพิกถอน — <strong className="font-semibold text-fg">ระบบไม่จัดเก็บไฟล์</strong> ตรวจเสร็จแล้วทิ้งทันที
        </p>

        <PdfVerifier />

        <section className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <h2 className="font-display text-lg font-semibold">ความหมายของผลการตรวจ</h2>
          <dl className="mt-3 space-y-3 leading-relaxed">
            <div>
              <dt className="font-semibold text-success-fg">ลายมือชื่อถูกต้อง</dt>
              <dd className="text-muted">
                เอกสารไม่ถูกแก้ไขหลังลงนาม และใบรับรองของผู้ลงนามออกโดยหน่วยงานที่ระบบเชื่อถือ ใช้งานได้ ณ เวลาลงนาม
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-warning-fg">ไม่ทราบความถูกต้อง</dt>
              <dd className="text-muted">
                เอกสารไม่ถูกแก้ไข แต่ระบบยืนยันตัวตนผู้ลงนามไม่ได้ เช่น ใบรับรองออกโดยหน่วยงานที่ระบบยังไม่รู้จัก หรือตรวจการเพิกถอนไม่ได้
              </dd>
            </div>
            <div>
              <dt className="font-semibold text-danger-fg">ลายมือชื่อไม่ถูกต้อง</dt>
              <dd className="text-muted">เอกสารถูกแก้ไขหลังลงนาม หรือใบรับรองถูกเพิกถอน/หมดอายุก่อนลงนาม — ไม่ควรเชื่อถือเอกสารนี้</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-muted">
            ต้องการให้ Acrobat หรือ Foxit แสดงว่าลายมือชื่อของมหาวิทยาลัยถูกต้องด้วย?{' '}
            <Link href="/root-ca" className="font-medium text-accent underline-offset-4 hover:underline">
              ติดตั้งใบรับรองหลัก
            </Link>
          </p>
        </section>
      </div>
    </PageShell>
  );
}
