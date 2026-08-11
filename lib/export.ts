import type { AssetRow, CampaignReviewRow, CampaignRow } from '@/lib/db/client';
import {
  positiveFiniteNumber,
  totalPassedVideoDuration,
  videoBudgetError,
} from '@/lib/video-budget';

/** Only Critic-passed assets are eligible for the final package. */
export const EXPORTABLE_ASSET_STATUS = 'passed' as const;

export interface ExportManifestAsset {
  id: string;
  planKey: string;
  type: string;
  platform: string;
  filename: string;
  mediaPath: string | null;
  markdown: string;
}

export interface CampaignExportManifest {
  assets: ExportManifestAsset[];
  campaignMarkdown: string;
}

/**
 * This filter is deliberately strict. A passing replacement is shippable; a
 * rejected, abandoned, replaced, planned, or merely generated row is history or
 * unfinished work, not part of the final package.
 */
export function selectExportAssets(assets: AssetRow[]): AssetRow[] {
  return assets
    .filter((asset) => asset.status === EXPORTABLE_ASSET_STATUS)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export function buildCampaignExportManifest(input: {
  campaign: CampaignRow;
  assets: AssetRow[];
  campaignReview: CampaignReviewRow | null;
}): CampaignExportManifest {
  const assets = selectExportAssets(input.assets).map((asset, index) => ({
    id: asset.id,
    planKey: asset.plan_key,
    type: asset.type,
    platform: asset.platform,
    filename: asset.type === 'short_video'
      ? `clips/${String(index + 1).padStart(2, '0')}-${safeFilename(asset.plan_key)}.mp4`
      : `written/${String(index + 1).padStart(2, '0')}-${safeFilename(asset.plan_key)}.md`,
    mediaPath: asset.type === 'short_video' ? asset.media_path : null,
    markdown: renderAssetMarkdown(asset),
  }));

  return {
    assets,
    campaignMarkdown: renderCampaignMarkdown(input.campaign, assets, input.campaignReview),
  };
}

export function exportAssetProblems(asset: AssetRow): string[] {
  const problems: string[] = [];
  if (asset.status !== EXPORTABLE_ASSET_STATUS) {
    problems.push(`status is ${asset.status}, not passed`);
  }
  if (asset.content === null) problems.push('content is missing');
  if (asset.type === 'short_video' && !asset.media_path) problems.push('local media path is missing');
  if (asset.type === 'short_video' && positiveFiniteNumber(asset.duration_sec) === null) {
    problems.push('rendered duration is missing');
  }
  return problems;
}

export function exportVideoBudgetProblem(
  campaign: Pick<CampaignRow, 'max_video_seconds'>,
  assets: AssetRow[],
): string | null {
  return videoBudgetError(
    totalPassedVideoDuration(assets),
    campaign.max_video_seconds,
  );
}

export function safeFilename(value: string): string {
  const normalized = value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const trimmed = normalized.replace(/^[.-]+|[.-]+$/g, '').slice(0, 80);
  return trimmed || 'asset';
}

function renderAssetMarkdown(asset: AssetRow): string {
  const content = recordOf(asset.content);
  const lines = [
    `# ${asset.plan_key}`,
    '',
    `- Type: ${asset.type}`,
    `- Platform: ${asset.platform}`,
    `- Status: ${asset.status}`,
    `- Revision count: ${asset.revision_count}`,
    asset.hook ? `- Hook: ${asset.hook}` : null,
    asset.duration_sec === null ? null : `- Duration: ${Number(asset.duration_sec).toFixed(2)}s`,
    '',
  ].filter((line): line is string => line !== null);

  if (asset.type === 'x_thread') {
    const tweets = stringsFrom(content?.tweets);
    lines.push('## Thread', '', ...tweets.map((tweet, index) => `${index + 1}. ${tweet}`));
  } else if (asset.type === 'linkedin_post') {
    lines.push('## Post', '', typeof content?.body === 'string' ? content.body : '(content unavailable)');
  } else {
    lines.push(
      '## Clip',
      '',
      `Caption: ${typeof content?.caption === 'string' ? content.caption : '(caption unavailable)'}`,
      typeof content?.clip_start === 'number' && typeof content?.clip_end === 'number'
        ? `Source timestamp: ${content.clip_start.toFixed(2)}s - ${content.clip_end.toFixed(2)}s`
        : 'Source timestamp: unavailable',
    );
  }

  const grounding = groundingFrom(content?.grounding);
  if (grounding.length > 0) {
    lines.push('', '## Transcript grounding', ...grounding.flatMap((item) => [`- Claim: ${item.claim}`, `  - Source: “${item.source_quote}”`]));
  }

  return `${lines.join('\n').trim()}\n`;
}

function renderCampaignMarkdown(
  campaign: CampaignRow,
  assets: ExportManifestAsset[],
  review: CampaignReviewRow | null,
): string {
  const scores = recordOf(review?.scores);
  const lines = [
    `# ${campaign.title ?? 'Chorus campaign'}`,
    '',
    `- Status: ${campaign.status}`,
    `- Goal: ${campaign.goal}`,
    campaign.audience ? `- Audience: ${campaign.audience}` : null,
    campaign.brand_voice ? `- Brand voice: ${campaign.brand_voice}` : null,
    `- Source duration: ${campaign.source_duration_sec === null ? 'unknown' : `${Number(campaign.source_duration_sec).toFixed(1)}s`}`,
    `- Media: ${campaign.has_video_stream === false ? 'audio-only caption cards' : campaign.has_video_stream === true ? 'video + audio' : 'unknown'}`,
    `- Completion mode: ${campaign.completion_mode ?? 'not recorded'}`,
    campaign.completion_note ? `- Completion rationale: ${campaign.completion_note}` : null,
    '',
    '## Included assets',
    '',
    ...(assets.length > 0 ? assets.map((asset) => `- [${asset.planKey}](${asset.filename}) - ${asset.type} for ${asset.platform}`) : ['- None.']),
  ].filter((line): line is string => line !== null);

  if (review && scores) {
    lines.push('', `## Campaign Reviewer scorecard (strategy v${review.version})`, '');
    lines.push(`- Model decision: ${review.model_decision ?? review.decision}`);
    lines.push(`- Effective decision: ${review.effective_decision ?? review.decision}`);
    for (const [key, value] of Object.entries(scores)) {
      if (typeof value === 'number') lines.push(`- ${key.replace(/_/g, ' ')}: ${value.toFixed(1)}`);
    }
    const problems = reviewProblems(review.problems);
    lines.push('', '### Unresolved reviewer problems', '');
    if (problems.length === 0) {
      lines.push('- None recorded.');
    } else {
      lines.push(...problems.map((problem) => `- ${problem.issue}${problem.asset_plan_keys.length > 0 ? ` (${problem.asset_plan_keys.join(', ')})` : ''}`));
    }
  }

  lines.push('', 'Rejected, abandoned, replaced, and unfinished assets are intentionally excluded from this package.');
  return `${lines.join('\n').trim()}\n`;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringsFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function groundingFrom(value: unknown): Array<{ claim: string; source_quote: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    return typeof record?.claim === 'string' && typeof record.source_quote === 'string'
      ? [{ claim: record.claim, source_quote: record.source_quote }]
      : [];
  });
}

function reviewProblems(value: unknown): Array<{ issue: string; asset_plan_keys: string[] }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    return typeof record?.issue === 'string'
      ? [{
          issue: record.issue,
          asset_plan_keys: Array.isArray(record.asset_plan_keys)
            ? record.asset_plan_keys.filter((key): key is string => typeof key === 'string')
            : [],
        }]
      : [];
  });
}
