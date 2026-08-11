import { CampaignReview } from '@/components/CampaignReview';

export default async function CampaignReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 px-4 py-4 lg:h-dvh lg:flex-none lg:overflow-hidden xl:px-6">
      <CampaignReview campaignId={id} />
    </main>
  );
}
