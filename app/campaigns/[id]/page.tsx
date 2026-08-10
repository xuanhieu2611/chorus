import Link from 'next/link';
import { CampaignMonitor } from '@/components/CampaignMonitor';

/**
 * The live dashboard. Phase 1 shows source facts, transcript progress, and the
 * event timeline; the agent graph and the asset cards land with the agents that
 * populate them.
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
