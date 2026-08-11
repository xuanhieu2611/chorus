import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { groundingEvidenceLabel } from '@/lib/ui-grounding';

export interface AssetView {
  id: string;
  plan_key: string;
  type: string;
  platform: string;
  source_segment_ids: string[];
  hook: string | null;
  content: unknown;
  media_url: string | null;
  duration_sec: number | string | null;
  status: string;
  revision_count: number;
  updated_at: string;
  reviews?: AssetReviewView[];
}

export interface AssetReviewView {
  id: string;
  asset_id: string;
  reviewer_agent: string;
  scores: unknown;
  required_checks: unknown;
  blocking_feedback: string | null;
  polish_feedback: string | null;
  grounding_audit: unknown;
  grounding_audit_passed: boolean;
  materially_contradicted: boolean;
  feedback: string;
  decision: 'PASS' | 'REVISE' | 'REJECT';
  revision_index: number;
  created_at: string;
}

export interface AssetSourceView {
  id: string;
  start_time: number | string;
  end_time: number | string;
  topic: string;
}

interface GroundingView {
  claim: string;
  source_quote: string;
}

export function AssetCard({
  asset,
  sources,
}: {
  asset: AssetView;
  sources: AssetSourceView[];
}) {
  const content = parseContent(asset.content);
  const latestReview = asset.reviews?.[asset.reviews.length - 1] ?? null;
  const scores = latestReview ? parseScores(latestReview.scores) : null;
  const requiredChecks = latestReview ? parseRequiredChecks(latestReview.required_checks) : null;
  const groundingAudit = latestReview ? parseGroundingAudit(latestReview.grounding_audit) : [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const selectedSources = asset.source_segment_ids.flatMap((id) => {
    const source = sourceById.get(id);
    return source ? [source] : [];
  });

  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{label(asset.type)}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{asset.platform}</Badge>
            <Badge variant={statusVariant(asset.status)}>{asset.status.replace(/_/g, ' ')}</Badge>
          </div>
        </div>
        <div>
          <p className="text-muted-foreground font-mono text-[10px]">{asset.plan_key}</p>
          {selectedSources.length > 0 && (
            <p className="text-muted-foreground mt-1 text-xs">
              Source{' '}
              {selectedSources
                .map((source) => `${clock(source.start_time)}-${clock(source.end_time)}`)
                .join(', ')}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {asset.hook && (
          <div className="border-l-2 border-sky-500 pl-3">
            <p className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
              Hook
            </p>
            <p className="mt-1 text-sm font-medium">{asset.hook}</p>
          </div>
        )}

        {asset.type === 'short_video' && asset.media_url && (
          <div className="overflow-hidden rounded-xl border bg-black">
            <video
              controls
              preload="metadata"
              playsInline
              src={asset.media_url}
              className="aspect-[9/16] max-h-[640px] w-full bg-black object-contain"
            >
              Your browser does not support MP4 playback.
            </video>
          </div>
        )}

        {content?.kind === 'short_video' && (
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-sm">
            <p>{content.caption}</p>
            <p className="text-muted-foreground font-mono text-[11px]">
              Clip {clock(content.clip_start)}-{clock(content.clip_end)} ·{' '}
              {(content.clip_end - content.clip_start).toFixed(1)}s ·{' '}
              {content.boundary_adjustments} boundary adjustment
              {content.boundary_adjustments === 1 ? '' : 's'}
            </p>
          </div>
        )}

        {content?.kind === 'x_thread' && (
          <ol className="flex flex-col gap-2">
            {content.tweets.map((tweet, index) => (
              <li key={index} className="bg-muted/40 rounded-lg border p-3 text-sm">
                <span className="text-muted-foreground mr-2 font-mono text-[10px]">
                  {index + 1}/{content.tweets.length}
                </span>
                {tweet}
              </li>
            ))}
          </ol>
        )}

        {content?.kind === 'linkedin_post' && (
          <div className="bg-muted/40 whitespace-pre-wrap rounded-lg border p-4 text-sm leading-6">
            {content.body}
          </div>
        )}

        {!content && (
          <p className="text-muted-foreground text-sm">
            {asset.type === 'short_video' ? 'Waiting for the Clip Producer.' : 'Waiting for the Writing Agent.'}
          </p>
        )}

        {latestReview && scores && (
          <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold tracking-wide uppercase">Critic review</p>
              <Badge variant={reviewVariant(latestReview.decision)}>
                {latestReview.decision} · {average(scores).toFixed(1)}/10
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
              {Object.entries(scores).map(([key, value]) => (
                <div key={key} className="bg-background/70 rounded border px-2 py-1.5">
                  <p className="text-muted-foreground">{key.replace(/_/g, ' ')}</p>
                  <p className="font-mono font-medium">{value.toFixed(1)}</p>
                </div>
              ))}
            </div>
            {requiredChecks && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                {Object.entries(requiredChecks).map(([key, passed]) => (
                  <div key={key} className="bg-background/70 flex items-center justify-between rounded border px-2 py-1.5">
                    <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
                    <Badge variant={passed ? 'default' : 'destructive'}>{passed ? 'pass' : 'fix'}</Badge>
                  </div>
                ))}
              </div>
            )}
            {latestReview.blocking_feedback ? (
              <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
                <p className="text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400">
                  Blocking feedback
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-5">{latestReview.blocking_feedback}</p>
              </div>
            ) : null}
            {latestReview.polish_feedback ? (
              <div className="mt-3 rounded-md border border-sky-500/25 bg-sky-500/5 p-2.5">
                <p className="text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-400">
                  Optional polish
                </p>
                <p className="text-muted-foreground mt-1 text-xs leading-5">{latestReview.polish_feedback}</p>
              </div>
            ) : null}
            {asset.revision_count > 0 && (
              <p className="text-muted-foreground mt-2 font-mono text-[10px]">
                revision {asset.revision_count}
              </p>
            )}
          </div>
        )}

        {asset.reviews && asset.reviews.length > 1 && (
          <p className="text-muted-foreground rounded-lg border px-3 py-2 font-mono text-[10px]">
            Score history: {scoreHistory(asset.reviews)}
          </p>
        )}

        {content && content.grounding.length > 0 && (
          <details className="group rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
            <summary className="cursor-pointer text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {groundingEvidenceLabel(content.grounding.length, latestReview)}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {content.grounding.map((item, index) => (
                <div key={`${item.claim}-${index}`} className="text-xs">
                  <p className="font-medium">{item.claim}</p>
                  <blockquote className="text-muted-foreground mt-1 border-l pl-2 italic">
                    “{item.source_quote}”
                  </blockquote>
                </div>
              ))}
            </div>
          </details>
        )}

        {latestReview && groundingAudit.length > 0 && (
          <details className="group rounded-lg border border-violet-500/25 bg-violet-500/5 p-3">
            <summary className="cursor-pointer text-xs font-medium text-violet-700 dark:text-violet-400">
              Semantic grounding audit: {latestReview.grounding_audit_passed ? 'passed' : 'needs revision'}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {groundingAudit.map((item, index) => (
                <div key={`${item.claim}-${index}`} className="text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{item.claim}</p>
                    <Badge variant={item.supported ? 'default' : 'destructive'}>
                      {item.supported ? 'supported' : 'unsupported'}
                    </Badge>
                    {item.overstates_source && <Badge variant="destructive">overstates source</Badge>}
                  </div>
                  <p className="text-muted-foreground mt-1 leading-5">{item.reason}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

type ParsedContent =
  | { kind: 'linkedin_post'; body: string; grounding: GroundingView[] }
  | { kind: 'x_thread'; tweets: string[]; grounding: GroundingView[] }
  | {
      kind: 'short_video';
      caption: string;
      clip_start: number;
      clip_end: number;
      boundary_adjustments: number;
      grounding: GroundingView[];
    };

function parseContent(value: unknown): ParsedContent | null {
  if (!isRecord(value)) return null;
  const grounding = parseGrounding(value.grounding);
  if (value.kind === 'linkedin_post' && typeof value.body === 'string') {
    return { kind: 'linkedin_post', body: value.body, grounding };
  }
  if (
    value.kind === 'short_video' &&
    typeof value.caption === 'string' &&
    typeof value.clip_start === 'number' &&
    typeof value.clip_end === 'number'
  ) {
    return {
      kind: 'short_video',
      caption: value.caption,
      clip_start: value.clip_start,
      clip_end: value.clip_end,
      boundary_adjustments:
        typeof value.boundary_adjustments === 'number' ? value.boundary_adjustments : 0,
      grounding,
    };
  }
  if (
    value.kind === 'x_thread' &&
    Array.isArray(value.tweets) &&
    value.tweets.every((tweet) => typeof tweet === 'string')
  ) {
    return { kind: 'x_thread', tweets: value.tweets, grounding };
  }
  return null;
}

function parseGrounding(value: unknown): GroundingView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      isRecord(item) &&
      typeof item.claim === 'string' &&
      typeof item.source_quote === 'string'
    ) {
      return [{ claim: item.claim, source_quote: item.source_quote }];
    }
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function statusVariant(
  status: string,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'rejected' || status === 'abandoned') return 'destructive';
  if (status === 'passed') return 'default';
  if (status === 'needs_review') return 'outline';
  return 'secondary';
}

function reviewVariant(
  decision: AssetReviewView['decision'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (decision === 'PASS') return 'default';
  if (decision === 'REJECT') return 'destructive';
  return 'outline';
}

interface CriticScoresView {
  hook: number;
  clarity: number;
  standalone: number;
  originality: number;
  audience_fit: number;
  payoff: number;
}

interface RequiredChecksView {
  brief_compliant: boolean;
  source_supported: boolean;
  standalone: boolean;
  payoff_delivered: boolean;
}

interface GroundingAuditView {
  claim: string;
  supported: boolean;
  overstates_source: boolean;
  reason: string;
}

function parseRequiredChecks(value: unknown): RequiredChecksView | null {
  if (!isRecord(value)) return null;
  const keys: Array<keyof RequiredChecksView> = [
    'brief_compliant',
    'source_supported',
    'standalone',
    'payoff_delivered',
  ];
  if (!keys.every((key) => typeof value[key] === 'boolean')) return null;
  return value as unknown as RequiredChecksView;
}

function parseGroundingAudit(value: unknown): GroundingAuditView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      isRecord(item) &&
      typeof item.claim === 'string' &&
      typeof item.supported === 'boolean' &&
      typeof item.overstates_source === 'boolean' &&
      typeof item.reason === 'string'
    ) {
      return [{
        claim: item.claim,
        supported: item.supported,
        overstates_source: item.overstates_source,
        reason: item.reason,
      }];
    }
    return [];
  });
}

function parseScores(value: unknown): CriticScoresView | null {
  if (!isRecord(value)) return null;
  const keys: Array<keyof CriticScoresView> = [
    'hook',
    'clarity',
    'standalone',
    'originality',
    'audience_fit',
    'payoff',
  ];
  if (!keys.every((key) => typeof value[key] === 'number')) return null;
  return value as unknown as CriticScoresView;
}

function average(scores: CriticScoresView): number {
  return Object.values(scores).reduce((sum, value) => sum + value, 0) / 6;
}

function scoreHistory(reviews: AssetReviewView[]): string {
  return reviews
    .map((review) => {
      const scores = parseScores(review.scores);
      return scores
        ? `r${review.revision_index}: ${average(scores).toFixed(1)} (${review.decision})`
        : null;
    })
    .filter((value): value is string => value !== null)
    .join(' → ');
}

function label(type: string): string {
  if (type === 'x_thread') return 'X thread';
  if (type === 'linkedin_post') return 'LinkedIn post';
  if (type === 'short_video') return 'Short video';
  return type.replace(/_/g, ' ');
}

function clock(seconds: number | string): string {
  const total = Math.floor(Number(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
