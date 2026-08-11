import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApprovalGate } from '@/components/ApprovalGate';

export interface PlannedAssetView {
  plan_key: string;
  type: 'short_video' | 'x_thread' | 'linkedin_post';
  platform: 'tiktok' | 'x' | 'linkedin';
  topic: string;
  purpose: string;
  segment_ids: string[];
  credits: number;
}

export interface RejectedTopicView {
  topic: string;
  reason: string;
  segment_ids?: string[];
}

export interface StrategyView {
  id: string;
  version: number;
  rationale: string;
  planned_assets: PlannedAssetView[];
  rejected_topics: RejectedTopicView[];
  approved_by: string | null;
  created_at: string;
}

export function StrategyPanel({
  campaignId,
  strategy,
  awaitingApproval,
}: {
  campaignId: string;
  strategy: StrategyView;
  awaitingApproval: boolean;
}) {
  const credits = strategy.planned_assets.reduce((total, asset) => total + asset.credits, 0);

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Strategy v{strategy.version}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{strategy.planned_assets.length} assets</Badge>
            <Badge variant="outline">{credits} credits</Badge>
            {strategy.approved_by && <Badge>approved by {strategy.approved_by}</Badge>}
          </div>
        </div>
        <p className="text-muted-foreground text-sm font-normal">{strategy.rationale}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 md:grid-cols-2">
          <section className="flex flex-col gap-2" aria-labelledby="selected-topics-heading">
            <h3 id="selected-topics-heading" className="text-xs font-semibold tracking-wide uppercase">
              Selected
            </h3>
            <div className="flex flex-col gap-2">
              {strategy.planned_assets.map((asset) => (
                <div key={asset.plan_key} className="bg-muted/50 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{asset.topic}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {asset.platform}
                    </Badge>
                    <span className="text-muted-foreground ml-auto font-mono text-[10px]">
                      {asset.credits} cr
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1.5 text-xs">{asset.purpose}</p>
                  <p className="text-muted-foreground mt-2 font-mono text-[10px]">
                    {asset.plan_key} · {asset.type.replace(/_/g, ' ')}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="rejected-topics-heading">
            <h3
              id="rejected-topics-heading"
              className="text-xs font-semibold tracking-wide text-rose-600 uppercase dark:text-rose-400"
            >
              Deliberately rejected
            </h3>
            <div className="flex flex-col gap-2">
              {strategy.rejected_topics.length > 0 ? strategy.rejected_topics.map((item, index) => (
                <div key={`${item.topic}-${index}`} className="rounded-lg border border-rose-500/20 p-3">
                  <p className="text-sm font-medium">{item.topic}</p>
                  <p className="text-muted-foreground mt-1.5 text-xs">{item.reason}</p>
                  {item.segment_ids && item.segment_ids.length > 0 && (
                    <p className="text-muted-foreground mt-2 font-mono text-[10px]">
                      Source segments: {item.segment_ids.join(', ')}
                    </p>
                  )}
                </div>
              )) : (
                <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-sm">
                  No topics were rejected in this strategy version.
                </p>
              )}
            </div>
          </section>
        </div>

        {awaitingApproval && <ApprovalGate campaignId={campaignId} />}
      </CardContent>
    </Card>
  );
}
