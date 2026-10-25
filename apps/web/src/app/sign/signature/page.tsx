import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageShell } from '@/components/PageShell';
import { SignatureImageEditor } from '@/components/signing/SignatureImageEditor';
import { getCurrentUser } from '@/lib/auth';
import { getMySignatureImage } from '@/lib/signing-batches';

export const metadata: Metadata = { title: 'ภาพลายเซ็น' };

// ตั้ง/เปลี่ยน/ลบภาพลายเซ็น (document:sign — API ตรวจสิทธิ์และตรวจว่าเป็น PNG อีกครั้ง) docs/design/document-signing.md ระยะ D2
export default async function SignatureImagePage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('document:sign')) redirect('/forbidden');

  const image = await getMySignatureImage();

  return (
    <PageShell title="ภาพลายเซ็น" backHref="/sign" user={user} width="form">
      <SignatureImageEditor image={image} />
    </PageShell>
  );
}
