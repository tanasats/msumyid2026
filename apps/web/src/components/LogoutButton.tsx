'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { Alert } from './Alert';
import { Button } from './Button';

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
    <div className="space-y-3">
      {failed && <Alert tone="danger">ออกจากระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</Alert>}
      <Button variant="secondary" fullWidth loading={pending} onClick={logout}>
        {!pending && <LogOut className="size-5" aria-hidden />}
        {pending ? 'กำลังออกจากระบบ...' : 'ออกจากระบบ'}
      </Button>
    </div>
  );
}
