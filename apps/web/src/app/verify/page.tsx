import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '@/components/PageShell';
import { PdfVerifier } from '@/components/verify/PdfVerifier';
import { ResultLegend } from '@/components/verify/ResultLegend';
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
          <ResultLegend className="mt-4" />
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
