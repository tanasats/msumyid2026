// โครงหน้าพื้นฐาน ใช้ร่วมกันทุกหน้า (responsive)
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4">
          <p className="text-base font-semibold sm:text-lg">ระบบบริหารจัดการใบรับรองดิจิทัล</p>
          <p className="text-sm text-slate-500">มหาวิทยาลัยมหาสารคาม</p>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
