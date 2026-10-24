'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TextField } from '@/components/TextField';
import { apiMutate } from '@/lib/api-client';

const CODE_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

/** สร้างบทบาทใหม่ (ไม่ใช่บทบาทระบบ) — กำหนดสิทธิ์ต่อที่การ์ดของบทบาทหลังสร้าง */
export function CreateRoleButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [nameTh, setNameTh] = useState('');
  const [isPrivileged, setIsPrivileged] = useState(false);

  function openDialog() {
    setCode('');
    setNameTh('');
    setIsPrivileged(false);
    setOpen(true);
  }

  async function handleConfirm(reason: string) {
    if (!CODE_PATTERN.test(code.trim())) {
      throw new Error('รหัสบทบาทใช้ a-z, 0-9 และ _ ขึ้นต้นด้วยตัวอักษร ยาว 2-50 ตัว เช่น registrar');
    }
    if (!nameTh.trim()) throw new Error('กรุณากรอกชื่อบทบาท');
    await apiMutate('/admin/role-permissions/roles', 'POST', {
      code: code.trim(),
      nameTh: nameTh.trim(),
      isPrivileged,
      reason,
    });
    router.refresh();
  }

  return (
    <>
      <Button fullWidth onClick={openDialog}>
        <Plus className="size-5" aria-hidden />
        สร้างบทบาท
      </Button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="สร้างบทบาทใหม่"
        description="สร้างแล้วกำหนดสิทธิ์ที่การ์ดของบทบาท และให้บทบาทแก่ผู้ใช้ที่หน้ารายละเอียดผู้ใช้ รหัสบทบาทเปลี่ยนภายหลังไม่ได้"
        confirmLabel="สร้างบทบาท"
        reason="required"
        reasonHint="บันทึกไว้ในประวัติการกำหนดบทบาทและสิทธิ์"
        onConfirm={handleConfirm}
      >
        <div className="space-y-4">
          <TextField
            name="new-role-code"
            label="รหัสบทบาท"
            value={code}
            onChange={(e) => setCode(e.target.value.toLowerCase())}
            hint="ภาษาอังกฤษตัวเล็ก ตัวเลข และ _ เช่น registrar"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={50}
          />
          <TextField
            name="new-role-name"
            label="ชื่อบทบาท"
            value={nameTh}
            onChange={(e) => setNameTh(e.target.value)}
            hint="เช่น เจ้าหน้าที่ทะเบียน"
            maxLength={100}
          />
          <label className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={isPrivileged}
              onChange={(e) => setIsPrivileged(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span className="text-sm">
              <span className="block font-medium">บทบาทสิทธิ์สูง</span>
              <span className="block text-muted">
                ให้/ถอนได้เฉพาะผู้ดูแลระบบสูงสุด และผู้ถือบทบาทนี้จัดการได้เฉพาะผู้ดูแลระบบสูงสุด — เปลี่ยนภายหลังไม่ได้
              </span>
            </span>
          </label>
        </div>
      </ConfirmDialog>
    </>
  );
}
