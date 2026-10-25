'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { buttonClasses } from '@/components/Button';
import { SigningPinForm } from './SigningPinForm';

/** หน้าเปลี่ยน PIN: เปลี่ยนสำเร็จแล้วกลับไปหน้าลงนาม */
export function ChangeSigningPin({ hasPin }: { hasPin: boolean }) {
  const router = useRouter();
  return (
    <SigningPinForm
      mode={hasPin ? 'change' : 'set'}
      onDone={() => router.push('/sign?pin=updated')}
      cancel={
        <Link href="/sign" className={buttonClasses({ variant: 'secondary', fullWidth: true })}>
          ยกเลิก
        </Link>
      }
    />
  );
}
