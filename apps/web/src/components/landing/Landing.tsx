import Link from 'next/link';
import {
  CalendarClock,
  FileCheck2,
  FileSignature,
  Fingerprint,
  ImageOff,
  KeyRound,
  Landmark,
  Link2,
  LogIn,
  ShieldBan,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import { MsuMark } from '@/components/BrandLogo';
import { buttonClasses } from '@/components/Button';
import { PageShell } from '@/components/PageShell';
import { SecurityPattern } from '@/components/SecurityPattern';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { PdfVerifier } from '@/components/verify/PdfVerifier';
import { ResultLegend } from '@/components/verify/ResultLegend';
import { getRootCa } from '@/lib/root-ca';
import type { ThemePreference } from '@/lib/theme';

/** ความกว้างของเนื้อหาในแต่ละส่วน (หน้าแลนดิ้งใช้ PageShell แบบ bleed แถบพื้นหลังจึงเต็มจอได้) */
const CONTAINER = 'mx-auto w-full max-w-6xl px-4 md:px-6 lg:px-8';

type Item = { icon: LucideIcon; title: string; detail: string };

const CHECKS: Item[] = [
  {
    icon: FileCheck2,
    title: 'เอกสารไม่ถูกแก้ไข',
    detail: 'เทียบค่าที่คำนวณจากเนื้อหาปัจจุบันกับค่าที่ผู้ลงนามรับรองไว้ และแจ้งเมื่อมีการเพิ่มเติมเอกสารหลังลงนาม',
  },
  {
    icon: Link2,
    title: 'ใครเป็นผู้ลงนาม',
    detail: 'ไล่สายใบรับรองจากผู้ลงนามขึ้นไปจนถึงใบรับรองหลักที่ระบบเชื่อถือ แล้วแสดงชื่อและอีเมลตามใบรับรอง',
  },
  {
    icon: ShieldBan,
    title: 'ใบรับรองยังไม่ถูกเพิกถอน',
    detail: 'ใบรับรองของมหาวิทยาลัยตรวจกับฐานข้อมูลของระบบโดยตรง จึงเป็นสถานะล่าสุดเสมอ',
  },
  {
    icon: CalendarClock,
    title: 'ลงนามเมื่อไร',
    detail: 'ถ้ามีการประทับเวลาจากหน่วยงานกลาง ระบบใช้เวลานั้น ลายมือชื่อที่ลงก่อนใบรับรองหมดอายุจึงยังถูกต้อง',
  },
];

/**
 * หน้าแลนดิ้งสาธารณะ (/ เมื่อยังไม่ได้ login) — เน้นการตรวจลายมือชื่อบนเอกสาร
 * และอธิบายกลไกความน่าเชื่อถือ (สายใบรับรอง) ให้คนทั่วไปเข้าใจ
 */
export function Landing({ theme }: { theme: ThemePreference }) {
  const ca = getRootCa();

  // สายความเชื่อถือ: จากบนลงล่าง ผู้รับรอง → ผู้ถูกรับรอง (เป็นลำดับจริง จึงแสดงเป็นเส้นต่อกัน)
  const chain: { mark: React.ReactNode; title: string; detail: string }[] = [
    {
      mark: <Landmark className="size-5" aria-hidden />,
      title: `ใบรับรองหลัก (Root) ของ ${ca.organization}`,
      detail: 'จุดเริ่มต้นของความเชื่อถือ ระบบนี้จดจำใบนี้ไว้แล้ว และคุณติดตั้งใน Acrobat หรือ Foxit เองได้',
    },
    {
      mark: <MsuMark className="h-3.5 w-auto" />,
      title: 'ใบรับรองของมหาวิทยาลัยมหาสารคาม',
      detail: 'ได้รับการรับรองจากใบรับรองหลัก ใช้ออกใบรับรองให้นิสิตและบุคลากรหลังยืนยันตัวตนด้วยบัญชีของมหาวิทยาลัย',
    },
    {
      mark: <UserRoundCheck className="size-5" aria-hidden />,
      title: 'ใบรับรองของผู้ลงนาม',
      detail: 'ระบุชื่อและอีเมลของผู้ลงนาม กุญแจลับสำหรับลงนามอยู่กับเจ้าของเท่านั้น ถ้าเลิกใช้หรือรั่วไหล มหาวิทยาลัยเพิกถอนได้ทันที',
    },
    {
      mark: <FileSignature className="size-5" aria-hidden />,
      title: 'ลายมือชื่อบนเอกสาร',
      detail: 'ผูกกับเนื้อหาเอกสารและใบรับรองของผู้ลงนาม ใครก็ตรวจย้อนขึ้นไปถึงใบรับรองหลักได้ด้วยตัวเอง',
    },
  ];

  return (
    <PageShell
      width="bleed"
      headerAction={
        <Link href="/login" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
          <LogIn className="size-5" aria-hidden />
          เข้าสู่ระบบ
        </Link>
      }
    >
      {/* ---- ส่วนบน: ตรวจได้ทันที ---- */}
      <section className="relative overflow-hidden">
        {/* ลายนิรภัยขนาดใหญ่หลังกล่องตรวจ — องค์ประกอบเด่นของหน้า (ตกแต่ง) */}
        <SecurityPattern className="pointer-events-none absolute top-1/2 -right-48 hidden size-[40rem] -translate-y-1/2 text-ornament opacity-40 lg:block" />
        {/* มือถือ: หัวข้อ → กล่องตรวจ → จุดเด่น (งานหลักอยู่สูงขึ้น) / desktop: ข้อความซ้าย กล่องตรวจขวา */}
        <div
          className={`${CONTAINER} relative grid gap-6 py-8 lg:grid-cols-[1fr_minmax(0,30rem)] lg:grid-rows-[auto_auto] lg:gap-x-12 lg:gap-y-6 lg:py-16`}
        >
          <div className="lg:self-end">
            <h1 className="font-display text-3xl leading-tight font-semibold sm:text-4xl lg:text-5xl">
              ตรวจสอบ<span className="whitespace-nowrap">ลายมือชื่อดิจิทัล</span>
              <span className="whitespace-nowrap">บนเอกสาร</span>
            </h1>
            <p className="mt-4 max-w-prose text-lg leading-relaxed text-muted">
              ได้รับไฟล์ PDF ที่ลงนามโดยนิสิตหรือบุคลากรมหาวิทยาลัยมหาสารคาม? อัปโหลดเพื่อตรวจว่าเอกสารไม่ถูกแก้ไข
              และรู้ว่าใครเป็นผู้ลงนาม
            </p>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
            <PdfVerifier />
          </div>
          <div className="lg:self-start">
            <ul className="space-y-2">
              {[
                'ไม่ต้องสมัครหรือเข้าสู่ระบบ',
                'ระบบไม่จัดเก็บไฟล์ ตรวจเสร็จแล้วทิ้งทันที',
                'ตรวจทุกลายมือชื่อในไฟล์ พร้อมบอกเหตุผล',
              ].map((text) => (
                <li key={text} className="flex items-start gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ---- ภาพลายเซ็น vs ลายมือชื่อดิจิทัล: ความเข้าใจผิดที่พบบ่อยที่สุด ---- */}
      <section className="border-y border-line bg-surface">
        <div className={`${CONTAINER} py-10 lg:py-14`}>
          <h2 className="font-display text-2xl font-semibold text-balance">ภาพลายเซ็นบนหน้ากระดาษ ไม่ใช่ลายมือชื่อดิจิทัล</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Compare
              icon={ImageOff}
              tone="bg-neutral-soft text-neutral-fg"
              title="ภาพลายเซ็น"
              detail="เป็นแค่รูปภาพ ใครก็คัดลอกไปวางบนเอกสารอื่นได้ และไม่บอกว่าเนื้อหาถูกแก้ไขหรือไม่ — ระบบนี้ตรวจภาพลายเซ็นไม่ได้"
            />
            <Compare
              icon={Fingerprint}
              tone="bg-accent-soft text-accent-soft-fg"
              title="ลายมือชื่อดิจิทัล"
              detail="คำนวณจากเนื้อหาทุกตัวอักษรด้วยกุญแจลับของผู้ลงนาม แก้เอกสารแม้จุดเดียว ลายมือชื่อจะใช้ไม่ได้ทันที และระบุตัวผู้ลงนามได้จากใบรับรอง"
            />
          </div>
        </div>
      </section>

      {/* ---- สายความเชื่อถือ ---- */}
      <section className={`${CONTAINER} grid gap-8 py-10 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16 lg:py-16`}>
        <div>
          <h2 className="font-display text-2xl font-semibold text-balance">เชื่อถือได้ เพราะมีผู้รับรองเป็นทอด ๆ</h2>
          <p className="mt-3 leading-relaxed text-muted">
            เหมือนบัตรประจำตัวที่ออกโดยหน่วยงานที่เราเชื่อถือ ใบรับรองดิจิทัลของผู้ลงนามออกโดยมหาวิทยาลัย
            และมหาวิทยาลัยก็ได้รับการรับรองจากระดับที่สูงขึ้นไป การตรวจลายมือชื่อคือการไล่ตรวจสายนี้ทีละขั้น
          </p>
          <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            ทุกขั้นตรวจด้วยคณิตศาสตร์ของกุญแจคู่ (public key) ไม่มีใครปลอมการรับรองได้โดยไม่มีกุญแจลับของผู้รับรอง
          </p>
        </div>

        <ol className="relative">
          {chain.map((step, i) => (
            <li key={step.title} className="relative flex gap-4 pb-8 last:pb-0">
              {/* เส้นเชื่อมระหว่างขั้น */}
              {i < chain.length - 1 && (
                <span aria-hidden className="absolute top-11 bottom-1 left-[1.375rem] w-px bg-line-input" />
              )}
              <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full border border-line-input bg-surface text-primary">
                {step.mark}
              </span>
              <div className="min-w-0 pt-2">
                <h3 className="font-semibold">{step.title}</h3>
                <p className="mt-1 leading-relaxed text-muted">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ---- ระบบตรวจอะไรบ้าง + ผล 3 ระดับ ---- */}
      <section className="border-y border-line bg-surface">
        <div className={`${CONTAINER} py-10 lg:py-14`}>
          <h2 className="font-display text-2xl font-semibold">ระบบตรวจอะไรบ้าง</h2>
          <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {CHECKS.map(({ icon: Icon, title, detail }) => (
              <li key={title}>
                <Icon className="size-6 text-primary" aria-hidden />
                <h3 className="mt-3 font-semibold">{title}</h3>
                <p className="mt-1 leading-relaxed text-muted">{detail}</p>
              </li>
            ))}
          </ul>

          <div className="mt-10 grid gap-6 border-t border-line pt-8 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16">
            <div>
              <h2 className="font-display text-2xl font-semibold">ผลการตรวจมี 3 ระดับ</h2>
              <p className="mt-3 leading-relaxed text-muted">
                แบบเดียวกับที่ Adobe Acrobat แสดงในแผงลายมือชื่อ แต่ละลายมือชื่อในไฟล์ได้ผลของตัวเอง พร้อมเหตุผล
              </p>
            </div>
            <ResultLegend />
          </div>
        </div>
      </section>

      {/* ---- ทางต่อสำหรับแต่ละกลุ่ม ---- */}
      <section className={`${CONTAINER} grid gap-4 py-10 md:grid-cols-2 lg:py-14`}>
        <div className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <h2 className="font-display text-xl font-semibold">ได้รับเอกสารจากมหาวิทยาลัยเป็นประจำ</h2>
          <p className="mt-2 leading-relaxed text-muted">
            ติดตั้งใบรับรองหลักครั้งเดียว แล้ว Acrobat หรือ Foxit จะแสดงว่าลายมือชื่อของมหาวิทยาลัยถูกต้องโดยไม่ต้องอัปโหลด
          </p>
          <Link href="/root-ca" className={`${buttonClasses({ variant: 'secondary', fullWidth: true })} mt-5`}>
            ติดตั้งใบรับรองหลัก
          </Link>
        </div>
        <div className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
          <h2 className="font-display text-xl font-semibold">นิสิตและบุคลากรมหาวิทยาลัยมหาสารคาม</h2>
          <p className="mt-2 leading-relaxed text-muted">
            เข้าสู่ระบบด้วยบัญชี @msu.ac.th เพื่อขอใบรับรองสำหรับลงนามเอกสารและเข้ารหัสอีเมล
          </p>
          <Link href="/login" className={`${buttonClasses({ fullWidth: true })} mt-5`}>
            เข้าสู่ระบบ
          </Link>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className={`${CONTAINER} flex flex-col items-start gap-4 py-6 sm:flex-row sm:items-center sm:justify-between`}>
          <p className="text-sm text-muted">MSU Digital ID ระบบใบรับรองดิจิทัล มหาวิทยาลัยมหาสารคาม</p>
          <ThemeSwitcher initial={theme} compact />
        </div>
      </footer>
    </PageShell>
  );
}

function Compare({ icon: Icon, tone, title, detail }: Item & { tone: string }) {
  return (
    <div className="flex gap-4 rounded-xl border border-line p-5">
      <span className={`flex size-11 shrink-0 items-center justify-center rounded-full ${tone}`}>
        <Icon className="size-6" aria-hidden />
      </span>
      <div className="min-w-0">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 leading-relaxed text-muted">{detail}</p>
      </div>
    </div>
  );
}
