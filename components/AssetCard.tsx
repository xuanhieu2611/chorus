import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
            <Badge variant={asset.status === 'needs_review' ? 'default' : 'secondary'}>
              {asset.status.replace(/_/g, ' ')}
            </Badge>
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
            {asset.type === 'short_video'
              ? 'Waiting for the Clip Producer in Phase 5.'
              : 'Waiting for the Writing Agent.'}
          </p>
        )}

        {content && content.grounding.length > 0 && (
          <details className="group rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
            <summary className="cursor-pointer text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {content.grounding.length} verified source quote
              {content.grounding.length === 1 ? '' : 's'}
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
      </CardContent>
    </Card>
  );
}

type ParsedContent =
  | { kind: 'linkedin_post'; body: string; grounding: GroundingView[] }
  | { kind: 'x_thread'; tweets: string[]; grounding: GroundingView[] };

function parseContent(value: unknown): ParsedContent | null {
  if (!isRecord(value)) return null;
  const grounding = parseGrounding(value.grounding);
  if (value.kind === 'linkedin_post' && typeof value.body === 'string') {
    return { kind: 'linkedin_post', body: value.body, grounding };
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
