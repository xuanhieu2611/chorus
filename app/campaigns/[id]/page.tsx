import Link from 'next/link';
import { CampaignMonitor } from '@/components/CampaignMonitor';

/**
 * The live dashboard. It shows source facts, analysis, strategy approval,
 * grounded writing, playable rendered clips, and the event timeline. The live graph lands in
 * Phase 8 after every production and review node exists.
 */
export default async function CampaignPage({ params }: PageProps<'/campaigns/[id]'>) {
  const { id } = await params;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <Link href="/" className="text-muted-foreground hover:text-foreground w-fit text-sm">
        ← New campaign
      </Link>
      <CampaignMonitor campaignId={id} />
    </main>
  );
}
