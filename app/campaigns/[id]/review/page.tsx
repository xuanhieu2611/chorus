import Link from 'next/link';
import { CampaignReview } from '@/components/CampaignReview';

export default async function CampaignReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-6 py-12">
      <Link href={`/campaigns/${id}`} className="text-muted-foreground hover:text-foreground w-fit text-sm">
        ← Campaign dashboard
      </Link>
      <CampaignReview campaignId={id} />
    </main>
  );
}
