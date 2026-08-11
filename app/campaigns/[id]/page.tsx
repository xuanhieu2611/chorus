import { CampaignMonitor } from '@/components/CampaignMonitor';

/**
 * The live dashboard. It shows source facts, analysis, strategy approval,
 * grounded writing, playable rendered clips, the live agent graph, and the event timeline.
 */
export default async function CampaignPage({ params }: PageProps<'/campaigns/[id]'>) {
  const { id } = await params;

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 px-4 py-4 lg:h-dvh lg:flex-none lg:overflow-hidden xl:px-6">
      <CampaignMonitor campaignId={id} />
    </main>
  );
}
