'use client';

import { useState } from 'react';

/** ปุ่มออกจากระบบ — เรียก API จาก browser เพื่อให้ API ลบ session cookie เอง */
export function LogoutButton() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`logout ล้มเหลว: ${res.status}`);
      // โหลดหน้าใหม่ทั้งหมดเพื่อล้างข้อมูลผู้ใช้ที่ค้างอยู่ใน cache ของ router
      window.location.assign('/login');
    } catch (err) {
      console.error(err);
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={logout}
        disabled={pending}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        {pending ? 'กำลังออก...' : 'ออกจากระบบ'}
      </button>
      {failed && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          ออกจากระบบไม่สำเร็จ กรุณาลองใหม่
        </p>
      )}
    </div>
  );
}
