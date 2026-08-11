'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { AssetView } from '@/components/AssetCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface GroundingView {
  claim: string;
  source_quote: string;
}

type ShowcaseContent =
  | { kind: 'linkedin_post'; body: string; grounding: GroundingView[] }
  | { kind: 'x_thread'; tweets: string[]; grounding: GroundingView[] }
  | { kind: 'short_video'; caption: string; clip_start: number; clip_end: number; grounding: GroundingView[] }
  | null;

export function AssetShowcase({
  campaignId,
  assets,
  complete,
  actionHref,
  actionLabel,
  staticComplete = false,
}: {
  campaignId: string;
  assets: AssetView[];
  complete: boolean;
  actionHref?: string;
  actionLabel?: string;
  staticComplete?: boolean;
}) {
  const visibleAssets = useMemo(
    () => assets.filter((asset) => !['abandoned', 'rejected'].includes(asset.status)),
    [assets],
  );
  const initialId = visibleAssets.find((asset) => asset.media_url)?.id ?? visibleAssets[0]?.id ?? '';
  const [selectedId, setSelectedId] = useState(initialId);
  const selected = visibleAssets.find((asset) => asset.id === selectedId) ?? visibleAssets[0] ?? null;
  const content = selected ? parseContent(selected.content) : null;

  if (!selected) {
    return (
      <section className="demo-panel flex min-h-[24rem] flex-col items-center justify-center text-center">
        <span className="output-mark" aria-hidden>+</span>
        <h2 className="mt-4 text-lg font-semibold tracking-tight">Production is next</h2>
        <p className="text-muted-foreground mt-2 max-w-sm text-sm">
          Approved ideas will appear here as the Writing Agent and Clip Producer finish them.
        </p>
      </section>
    );
  }

  return (
    <section className="demo-panel grid min-h-0 overflow-hidden lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="flex min-h-0 flex-col border-border lg:border-r">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-[0.16em]">
              Selected output
            </p>
            <h2 className="mt-1 truncate text-sm font-semibold">{selected.hook ?? assetLabel(selected.type)}</h2>
          </div>
          <div className="ml-4 flex shrink-0 items-center gap-2">
            <Badge variant="outline" className="bg-card border-border">{selected.platform}</Badge>
            <Badge variant={selected.status === 'passed' ? 'default' : 'secondary'}>
              {selected.status.replace(/_/g, ' ')}
            </Badge>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 place-items-center overflow-hidden p-5">
          {selected.type === 'short_video' && selected.media_url ? (
            <div className="flex h-full max-h-[30rem] items-center gap-6">
              <div className="video-frame h-full min-h-0 overflow-hidden bg-black">
                <video
                  controls
                  preload="metadata"
                  playsInline
                  src={selected.media_url}
                  className="h-full max-h-[30rem] aspect-[9/16] bg-black object-contain"
                >
                  Your browser does not support MP4 playback.
                </video>
              </div>
              <div className="hidden max-w-sm xl:block">
                <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-[0.16em]">Clip hook</p>
                <p className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.035em] text-balance">
                  {selected.hook}
                </p>
                {content?.kind === 'short_video' && (
                  <p className="text-muted-foreground mt-4 line-clamp-8 text-sm leading-6 text-pretty">{content.caption}</p>
                )}
                <p className="text-muted-foreground mt-5 font-mono text-[10px]">
                  {formatDuration(selected.duration_sec)} / revision {selected.revision_count}
                </p>
              </div>
            </div>
          ) : selected.type === 'short_video' && content?.kind === 'short_video' ? (
            <div className="flex h-full max-h-[30rem] items-center gap-6">
              <div className="mock-video-frame aspect-[9/16] h-full max-h-[30rem]">
                <div className="mock-video-frame__speaker" aria-hidden>AM</div>
                <div className="mock-video-frame__caption">{selected.hook}</div>
                <span className="mock-video-frame__label">Mock clip preview</span>
              </div>
              <div className="hidden max-w-sm xl:block">
                <p className="text-muted-foreground text-[10px] font-medium uppercase tracking-[0.16em]">Clip transcript</p>
                <p className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.035em] text-balance">{selected.hook}</p>
                <p className="text-muted-foreground mt-4 line-clamp-8 text-sm leading-6 text-pretty">{content.caption}</p>
                <p className="text-muted-foreground mt-5 font-mono text-[10px]">{formatDuration(selected.duration_sec)} / no media loaded</p>
              </div>
            </div>
          ) : content?.kind === 'x_thread' ? (
            <article className="social-sheet mx-auto w-full max-w-2xl p-6">
              <div className="mb-5 flex items-center gap-3">
                <div className="brand-avatar">C</div>
                <div><p className="text-sm font-semibold">Chorus</p><p className="text-muted-foreground text-xs">@chorus</p></div>
              </div>
              <ol className="space-y-4">
                {content.tweets.slice(0, 4).map((tweet, index) => (
                  <li key={index} className="flex gap-3 text-sm leading-6">
                    <span className="text-muted-foreground w-4 shrink-0 font-mono text-[10px]">{index + 1}</span>
                    <span className={index > 2 ? 'line-clamp-2' : ''}>{tweet}</span>
                  </li>
                ))}
              </ol>
            </article>
          ) : content?.kind === 'linkedin_post' ? (
            <article className="social-sheet mx-auto w-full max-w-2xl p-7">
              <div className="mb-5 flex items-center gap-3">
                <div className="brand-avatar">C</div>
                <div><p className="text-sm font-semibold">Chorus</p><p className="text-muted-foreground text-xs">Evidence-backed campaign</p></div>
              </div>
              <p className="line-clamp-[13] whitespace-pre-wrap text-[15px] leading-6">{content.body}</p>
            </article>
          ) : (
            <p className="text-muted-foreground text-sm">This asset is still being assembled.</p>
          )}
        </div>
      </div>

      <aside className="bg-muted/35 flex min-h-0 flex-col">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-xs font-semibold">Campaign set</p>
          <span className="text-muted-foreground font-mono text-[10px]">{visibleAssets.length} outputs</span>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {visibleAssets.map((asset, index) => (
            <button
              key={asset.id}
              type="button"
              onClick={() => setSelectedId(asset.id)}
              className={`output-row ${asset.id === selected.id ? 'output-row--active' : ''}`}
            >
              <span className="text-muted-foreground font-mono text-[10px]">0{index + 1}</span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs font-medium">{asset.hook ?? assetLabel(asset.type)}</span>
                <span className="text-muted-foreground mt-1 block text-[10px]">
                  {assetLabel(asset.type)} / {asset.platform}
                </span>
              </span>
              <span className={`size-1.5 rounded-full ${asset.status === 'passed' ? 'bg-emerald-600' : 'bg-muted-foreground/35'}`} />
            </button>
          ))}
        </div>
        <div className="border-t border-border p-3">
          {complete && staticComplete ? (
            <div className="flex items-center justify-center gap-2 px-2 py-1 text-center text-[10px] text-emerald-300">
              <span aria-hidden>✓</span>
              Walkthrough complete. Explore the outputs and evidence tabs.
            </div>
          ) : complete ? (
            <Button asChild className="w-full" size="lg">
              <Link href={actionHref ?? `/campaigns/${campaignId}/review`}>
                {actionLabel ?? 'Open final campaign'}
              </Link>
            </Button>
          ) : (
            <p className="text-muted-foreground px-2 py-1 text-center text-[10px]">Updates as agents finish each asset</p>
          )}
        </div>
      </aside>
    </section>
  );
}

function parseContent(value: unknown): ShowcaseContent {
  if (!isRecord(value)) return null;
  const grounding = parseGrounding(value.grounding);
  if (value.kind === 'linkedin_post' && typeof value.body === 'string') return { kind: 'linkedin_post', body: value.body, grounding };
  if (value.kind === 'x_thread' && Array.isArray(value.tweets) && value.tweets.every((tweet) => typeof tweet === 'string')) {
    return { kind: 'x_thread', tweets: value.tweets, grounding };
  }
  if (value.kind === 'short_video' && typeof value.caption === 'string' && typeof value.clip_start === 'number' && typeof value.clip_end === 'number') {
    return { kind: 'short_video', caption: value.caption, clip_start: value.clip_start, clip_end: value.clip_end, grounding };
  }
  return null;
}

function parseGrounding(value: unknown): GroundingView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && typeof item.claim === 'string' && typeof item.source_quote === 'string'
    ? [{ claim: item.claim, source_quote: item.source_quote }]
    : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assetLabel(type: string): string {
  if (type === 'x_thread') return 'X thread';
  if (type === 'linkedin_post') return 'LinkedIn post';
  if (type === 'short_video') return 'Short video';
  return type.replace(/_/g, ' ');
}

function formatDuration(value: number | string | null): string {
  if (value === null) return 'duration pending';
  return `${Number(value).toFixed(1)} seconds`;
}
