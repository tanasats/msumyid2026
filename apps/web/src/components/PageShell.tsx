import { LogoutButton } from './LogoutButton';

type ShellUser = { name: string; email: string };

// โครงหน้าพื้นฐาน ใช้ร่วมกันทุกหน้า (responsive) — ส่ง user มาเมื่อ login แล้วเพื่อแสดงชื่อและปุ่มออกจากระบบ
export function PageShell({ children, user }: { children: React.ReactNode; user?: ShellUser }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <p className="text-base font-semibold sm:text-lg">ระบบบริหารจัดการใบรับรองดิจิทัล</p>
            <p className="text-sm text-slate-500">มหาวิทยาลัยมหาสารคาม</p>
          </div>
          {user && (
            <div className="flex shrink-0 items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="text-xs text-slate-500">{user.email}</p>
              </div>
              <LogoutButton />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
    </div>
  );
}
