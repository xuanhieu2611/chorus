import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface CampaignReviewView {
  id: string;
  version: number;
  decision: 'APPROVE' | 'REPLAN';
  model_decision: 'APPROVE' | 'REPLAN';
  effective_decision: 'APPROVE' | 'REPLAN';
  scores: {
    asset_quality: number;
    diversity: number;
    audience_fit: number;
    brand_consistency: number;
    overall: number;
  };
  problems: Array<{ issue: string; asset_plan_keys: string[] }>;
  recommendations: Array<{
    action: 'keep' | 'replace';
    plan_key: string;
    replacement_topic: string | null;
    replacement_segment_ids: string[];
    replacement_reason: string | null;
    prior_rejection_addressed: string | null;
  }>;
}

export function CampaignReviewCard({ review }: { review: CampaignReviewView }) {
  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Campaign Reviewer scorecard</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
          <Badge variant={review.effective_decision === 'APPROVE' ? 'default' : 'destructive'}>
              Effective: {review.effective_decision}
            </Badge>
            <Badge variant="outline">Model: {review.model_decision}</Badge>
          </div>
        </div>
        <p className="text-muted-foreground text-xs">Portfolio review for strategy v{review.version}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {Object.entries(review.scores).map(([key, value]) => (
            <div key={key} className="bg-muted/40 rounded-lg border px-3 py-2">
              <p className="text-muted-foreground text-[10px] tracking-wide uppercase">
                {key.replace(/_/g, ' ')}
              </p>
              <p className="mt-1 font-mono text-sm font-medium">{value.toFixed(1)}</p>
            </div>
          ))}
        </div>

        {review.problems.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="campaign-review-problems">
            <h3 id="campaign-review-problems" className="text-xs font-semibold tracking-wide uppercase">
              Portfolio problems
            </h3>
            {review.problems.map((problem, index) => (
              <div key={`${problem.issue}-${index}`} className="rounded-lg border border-amber-500/30 p-3">
                <p className="text-sm">{problem.issue}</p>
                {problem.asset_plan_keys.length > 0 && (
                  <p className="text-muted-foreground mt-1 font-mono text-[10px]">
                    Assets: {problem.asset_plan_keys.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}

        {review.recommendations.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="campaign-review-recommendations">
            <h3 id="campaign-review-recommendations" className="text-xs font-semibold tracking-wide uppercase">
              Recommendations
            </h3>
            {review.recommendations.map((recommendation, index) => (
              <div key={`${recommendation.plan_key}-${index}`} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{recommendation.action}</Badge>
                  <span className="font-mono text-xs">{recommendation.plan_key}</span>
                </div>
                {recommendation.action === 'replace' && (
                  <>
                    <p className="text-muted-foreground mt-2 text-xs">
                      Replace with “{recommendation.replacement_topic}” from{' '}
                      <span className="font-mono">{recommendation.replacement_segment_ids.join(', ')}</span>.
                    </p>
                    {recommendation.replacement_reason && (
                      <p className="text-muted-foreground mt-1 text-xs">
                        Why: {recommendation.replacement_reason}
                      </p>
                    )}
                    {recommendation.prior_rejection_addressed && (
                      <p className="text-amber-700 mt-1 text-xs dark:text-amber-300">
                        Prior rejection addressed: {recommendation.prior_rejection_addressed}
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
