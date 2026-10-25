import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { PageShell } from '@/components/PageShell';
import { BatchProgress } from '@/components/signing/BatchProgress';
import { getCurrentUser } from '@/lib/auth';
import { getMySigningBatch } from '@/lib/signing-batches';

export const metadata: Metadata = { title: 'ผลการลงนาม' };

// ความคืบหน้าและผลของชุดการลงนาม (document:sign — API ตรวจเจ้าของชุดอีกครั้ง ชุดของคนอื่น = ไม่พบ)
export default async function SigningBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.approvalStatus !== 'approved') redirect('/pending');
  if (!user.permissions.includes('document:sign')) redirect('/forbidden');

  const { id } = await params;
  const batch = await getMySigningBatch(id);
  if (!batch) notFound();

  return (
    <PageShell title="ผลการลงนาม" backHref="/sign" user={user} width="form">
      <BatchProgress initial={batch} />
    </PageShell>
  );
}
