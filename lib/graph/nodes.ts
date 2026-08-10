import { mkdir, stat } from 'node:fs/promises';
import { reviewStrategy } from '@/lib/agents/director';
import { analyzeSource } from '@/lib/agents/source-analyst';
import { createStrategy } from '@/lib/agents/strategist';
import { produceClip } from '@/lib/agents/clip-producer';
import { writeAsset, type WrittenAssetType } from '@/lib/agents/writer';
import { emit } from '@/lib/events';
import { env } from '@/lib/env';
import { chargeCampaign } from '@/lib/llm/budget';
import { extractAudio, probe } from '@/lib/media/ffmpeg';
import {
  campaignAudioPath,
  campaignWorkDir,
  resolveSourcePath,
} from '@/lib/media/paths';
import { PROVIDER, transcribeAudio } from '@/lib/media/transcribe';
import {
  beginAssetGeneration,
  countSegments,
  ensurePlannedAssets,
  getDirectorReview,
  getLatestStrategy,
  getRevisionRequest,
  getSegments,
  getTranscript,
  hasTranscript,
  markStrategyApproved,
  planFromStrategy,
  saveSegments,
  saveStrategy,
  saveTranscript,
  saveVideoAsset,
  saveWrittenAsset,
} from '@/lib/tools';
import type { NodeFn, NodeId, NodeResult } from '@/lib/graph/types';

/**
 * One function per node. Control flow lives here; the executor in
 * `lib/graph/run.ts` only walks the edges these functions return.
 *
 * Built so far: `ingest` and `transcribe` (Phase 1), `analyze` (Phase 2),
 * `strategize`, `director_review_plan`, and the first gate (Phase 3), the
 * Writing Agent branch of `produce` (Phase 4), and the Clip Producer (Phase 5).
 * Nodes for later phases are absent
 * from the registry rather than stubbed, and
 * `run.ts` stops cleanly when it reaches one. A plausible empty stub is worse
 * than a missing entry because it makes an unbuilt phase look complete.
 */

/**
 * ffprobe the source, then downmix its audio for transcription.
 *
 * `has_video_stream` is decided here, once, and written to the row. Every later
 * branch reads that column rather than looking at the file extension, because an
 * MP4 can legally contain no video track and extension-sniffing sends blank
 * frames to a vision model.
 */
const ingest: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  if (!campaign.source_path) {
    throw new Error('Campaign has no source_path. The upload did not complete.');
  }

  const sourcePath = resolveSourcePath(campaign.source_path);
  await assertReadable(sourcePath);

  const probed = await probe(sourcePath);
  await emit({
    campaignId,
    agent: 'system',
    node: 'ingest',
    level: 'tool',
    message: `ffprobe: ${formatDuration(probed.durationSec)}, ${probed.hasVideoStream ? 'video + audio' : 'audio only'}.`,
    data: {
      duration_sec: probed.durationSec,
      has_video_stream: probed.hasVideoStream,
      format: probed.formatName,
      size_bytes: probed.sizeBytes,
    },
  });

  if (!probed.hasAudioStream) {
    throw new Error('Source has no audio stream, so there is nothing to transcribe.');
  }

  const audioPath = campaignAudioPath(campaignId);
  await mkdir(campaignWorkDir(campaignId), { recursive: true });

  // Re-extraction after a crash costs a minute of CPU for no new information, so
  // an audio file that already exists is trusted. It is derived from an
  // immutable source, so it cannot be stale.
  const existing = await sizeOf(audioPath);
  if (existing !== null && existing > 0) {
    await emit({
      campaignId,
      agent: 'system',
      node: 'ingest',
      level: 'info',
      message: `Reusing audio extracted by an earlier run (${formatBytes(existing)}).`,
    });
  } else {
    await extractAudio(sourcePath, audioPath);
    const size = (await sizeOf(audioPath)) ?? 0;
    await emit({
      campaignId,
      agent: 'system',
      node: 'ingest',
      level: 'tool',
      message: `ffmpeg: extracted 16 kHz mono audio, ${formatBytes(size)}.`,
      data: { audio_bytes: size },
    });
  }

  return {
    next: 'transcribe',
    patch: {
      source_duration_sec: probed.durationSec,
      has_video_stream: probed.hasVideoStream,
    },
    reason: `Ingested ${formatDuration(probed.durationSec)} of ${probed.hasVideoStream ? 'video' : 'audio-only'} source. ${
      probed.hasVideoStream
        ? 'Clips can be cropped to 9:16 from the video track.'
        : 'Clips will be caption cards; the 9:16 crop and the vision pass are skipped.'
    }`,
  };
};

/**
 * Word-timestamped transcript via Groq, chunked when the file exceeds the upload
 * cap. The chunk-offset merge lives in `lib/media/transcribe.ts` and is unit
 * tested, because getting it wrong misaligns every caption in the campaign
 * without throwing anything.
 */
const transcribe: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  if (await hasTranscript(campaignId)) {
    return {
      next: 'analyze',
      reason: 'Transcript already exists from an earlier run; not paying to transcribe it twice.',
    };
  }

  const audioPath = campaignAudioPath(campaignId);
  await assertReadable(audioPath);

  const durationSec = Number(campaign.source_duration_sec ?? 0);
  if (durationSec <= 0) {
    throw new Error('Campaign has no source duration; ingest did not complete.');
  }

  const result = await transcribeAudio(audioPath, {
    durationSec,
    workDir: campaignWorkDir(campaignId),
    onProgress: ({ chunk, of }) => {
      if (of === 1) return;
      void emit({
        campaignId,
        agent: 'system',
        node: 'transcribe',
        level: 'tool',
        message: `Transcribing chunk ${chunk} of ${of}.`,
      });
    },
  });

  // Save before charging. If the cost lands over the ceiling the run must fail,
  // but throwing away a transcript that was already paid for would mean paying
  // for it again on the retry.
  await saveTranscript(campaignId, {
    text: result.text,
    words: result.words,
    language: result.language,
    provider: PROVIDER,
  });

  // Groq's transcription API returns no cost figure, so this is list price times
  // audio hours rather than a reported number. See `USD_PER_AUDIO_HOUR`.
  await chargeCampaign(campaignId, result.costUsd, {
    agent: 'system',
    node: 'transcribe',
    model: PROVIDER,
  });

  if (result.words.length === 0) {
    throw new Error(
      'Transcription returned no word timestamps. Every clip boundary and caption depends on them.',
    );
  }

  return {
    next: 'analyze',
    reason: `Transcribed ${formatDuration(durationSec)} into ${result.words.length.toLocaleString('en-US')} word-timestamped words${
      result.chunkCount > 1 ? ` across ${result.chunkCount} chunks` : ''
    }.`,
  };
};

/**
 * Source Analyst: the transcript becomes a scored pool of topic segments.
 *
 * The agent owns judgement (what is interesting, how standalone it is); this
 * node owns everything around it: resumption, progress reporting, and turning
 * the result into the one line the demo opens on. The map-reduce and the
 * boundary arithmetic live in `lib/agents/source-analyst.ts`.
 */
const analyze: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;

  // Analysis is the first genuinely expensive node, a dozen model calls on a
  // 90 minute episode. A campaign resumed after a crash further downstream must
  // not pay for it twice, and segments already in the table are as good as the
  // ones a re-run would produce.
  const existing = await countSegments(campaignId);
  if (existing > 0) {
    return {
      next: 'strategize',
      reason: `Reusing ${existing} segments from an earlier analysis of this campaign.`,
    };
  }

  const transcript = await getTranscript(campaignId);

  const result = await analyzeSource({
    campaignId,
    words: transcript.words,
    goal: campaign.goal,
    audience: campaign.audience,
    brandVoice: campaign.brand_voice,
    onProgress: ({ done, of }) => {
      void emit({
        campaignId,
        agent: 'source_analyst',
        node: 'analyze',
        level: 'tool',
        message: `Scanned window ${done} of ${of}.`,
      });
    },
    onWindowFailure: ({ index, error }) => {
      // Named rather than swallowed. A window that produced nothing is a hole in
      // the episode, and a person reading the timeline should be able to see
      // which minutes the campaign was planned without.
      void emit({
        campaignId,
        agent: 'source_analyst',
        node: 'analyze',
        level: 'warn',
        message: `Window ${index + 1} could not be analyzed and was skipped: ${error}`,
      });
    },
  });

  const saved = await saveSegments(campaignId, result.segments);

  await emit({
    campaignId,
    agent: 'source_analyst',
    node: 'analyze',
    level: 'info',
    message: `Reduced ${result.candidateCount} candidates from ${result.windowCount} windows down to ${saved.length} segments. ${result.reasoning}`,
    data: {
      window_count: result.windowCount,
      candidate_count: result.candidateCount,
      failed_windows: result.failedWindows,
      segment_count: saved.length,
    },
  });

  // The line the demo opens on (MVP section 13, step 2).
  return {
    next: 'strategize',
    reason: `Found ${saved.length} candidate topic${saved.length === 1 ? '' : 's'} across ${formatDuration(Number(campaign.source_duration_sec ?? 0))} of source.`,
  };
};

/**
 * Content Strategist: turn the scored segment pool into a versioned, constrained
 * campaign plan. A saved plan is reused after a crash unless a Director or human
 * explicitly asked for changes, so resumption never pays for the same plan twice.
 */
const strategize: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;
  const latest = await getLatestStrategy(campaignId);
  const revision = latest ? await getRevisionRequest(campaignId, latest) : null;

  if (latest && !revision) {
    return {
      next: 'director_review_plan',
      reason: `Reusing strategy v${latest.version} from an earlier run; no review has requested a replacement.`,
    };
  }

  const segments = await getSegments(campaignId);
  if (segments.length < 2) {
    throw new Error(
      `The Strategist needs at least two source segments to build a portfolio; analysis produced ${segments.length}.`,
    );
  }

  const maxAssets = Math.min(campaign.max_assets, env.maxAssets);
  const plan = await createStrategy({
    campaignId,
    segments,
    goal: campaign.goal,
    audience: campaign.audience,
    brandVoice: campaign.brand_voice,
    platforms: campaign.platforms,
    creditBudget: campaign.credit_budget,
    maxAssets,
    maxVideoSeconds: campaign.max_video_seconds,
    requiredChanges: revision?.requiredChanges,
  });

  const saved = await saveStrategy(campaignId, (latest?.version ?? 0) + 1, plan);
  const totalCredits = plan.planned_assets.reduce((sum, asset) => sum + asset.credits, 0);

  await emit({
    campaignId,
    agent: 'content_strategist',
    node: 'strategize',
    level: 'info',
    message: `Strategy v${saved.version} selects ${plan.planned_assets.length} assets and rejects ${plan.rejected_topics.length} topics.`,
    data: {
      strategy_id: saved.id,
      version: saved.version,
      assets: plan.planned_assets.length,
      credits: totalCredits,
      revision_source: revision?.source ?? null,
    },
  });

  return {
    next: 'director_review_plan',
    reason: `Planned ${plan.planned_assets.length} assets for ${totalCredits} of ${campaign.credit_budget} credits, with ${plan.rejected_topics.length} explicit rejection${plan.rejected_topics.length === 1 ? '' : 's'}.`,
  };
};

/**
 * Content Director: one objective-focused review. The structured agent run is
 * durable memory, so restarting this node reuses the paid decision. TypeScript
 * owns the replan limit and edge selection.
 */
const directorReviewPlan: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;
  const strategy = await getLatestStrategy(campaignId);
  if (!strategy) throw new Error('Director review reached without a saved strategy.');

  const plan = planFromStrategy(strategy);
  const prior = await getDirectorReview(campaignId, strategy);
  const review =
    prior?.review ??
    (await reviewStrategy({
      campaignId,
      strategyVersion: strategy.version,
      strategy: plan,
      goal: campaign.goal,
      audience: campaign.audience,
      brandVoice: campaign.brand_voice,
    }));

  if (review.decision === 'APPROVE') {
    await markStrategyApproved(strategy.id, 'director');
    return {
      next: 'await_strategy_approval',
      reason: `Director approved strategy v${strategy.version}: ${review.reasoning}`,
    };
  }

  // Version N exists after N-1 replans. If replan_count already reaches this
  // version, this exact rejection was counted before a crash and only its edge
  // remains to be traversed. Otherwise consume one replan if one is available.
  if (campaign.replan_count >= strategy.version) {
    return {
      next: 'strategize',
      reason: `Resuming the Director's rejection of strategy v${strategy.version}: ${review.required_changes.join(' ')}`,
    };
  }

  if (campaign.replan_count < env.maxCampaignReplans) {
    const nextCount = campaign.replan_count + 1;
    return {
      next: 'strategize',
      patch: { replan_count: nextCount },
      reason: `Director rejected strategy v${strategy.version} and requested replan ${nextCount} of ${env.maxCampaignReplans}: ${review.required_changes.join(' ')}`,
    };
  }

  await emit({
    campaignId,
    agent: 'content_director',
    node: 'director_review_plan',
    level: 'warn',
    message: `Director rejected strategy v${strategy.version}, but the campaign has used all ${env.maxCampaignReplans} replans.`,
    data: { required_changes: review.required_changes },
  });
  return {
    next: 'finalize',
    reason: `Director rejected strategy v${strategy.version}, and no replans remain. The campaign will finalize without producing this rejected plan.`,
  };
};

/** Human gate. Approval and change requests are handled by the route, which
 * chooses the resume node before putting the campaign back on the worker queue. */
const awaitStrategyApproval: NodeFn = async (): Promise<NodeResult> => ({
  next: null,
  patch: { status: 'awaiting_strategy_approval' },
  reason: 'Strategy passed Director review and is waiting for human approval before production spends more credits.',
});

/**
 * Materialize the approved plan and produce every asset while the Critic is not
 * built yet. Writing uses verbatim excerpts. Video runs the full draft,
 * inspect, word-boundary adjustment, vertical render, caption burn, and upload
 * path. Phase 6 narrows this temporary sweep to the graph's final one-asset-at-a-time
 * produce/critique loop.
 */
const produce: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;
  const strategy = await getLatestStrategy(campaignId);
  if (!strategy) throw new Error('Production reached without a saved strategy.');
  if (strategy.approved_by !== 'human') {
    throw new Error(`Strategy v${strategy.version} has not passed the human approval gate.`);
  }

  const plan = planFromStrategy(strategy);
  const [assets, segments] = await Promise.all([
    ensurePlannedAssets(campaignId, plan.planned_assets),
    getSegments(campaignId),
  ]);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const assetByKey = new Map(assets.map((asset) => [asset.plan_key, asset]));
  let produced = 0;
  let reused = 0;

  for (const planned of plan.planned_assets) {
    if (!isWrittenType(planned.type)) continue;
    const asset = assetByKey.get(planned.plan_key);
    if (!asset) throw new Error(`No asset row exists for ${planned.plan_key}.`);

    if (asset.status === 'needs_review' && asset.content) {
      reused++;
      continue;
    }
    if (asset.status !== 'planned' && asset.status !== 'generating') {
      throw new Error(
        `Written asset ${planned.plan_key} cannot be produced from status ${asset.status}.`,
      );
    }

    const sources = planned.segment_ids.map((id) => {
      const segment = segmentById.get(id);
      if (!segment) throw new Error(`Writing plan ${planned.plan_key} references missing segment ${id}.`);
      return {
        id: segment.id,
        startTime: Number(segment.start_time),
        endTime: Number(segment.end_time),
        transcript: segment.transcript,
      };
    });

    const remainingCredits = await beginAssetGeneration(asset.id, planned.credits);
    await emit({
      campaignId,
      agent: 'writing_agent',
      node: 'produce',
      level: 'tool',
      message: `${planned.plan_key}: read ${sources.length} verbatim source excerpt${sources.length === 1 ? '' : 's'} and reserved ${planned.credits} credits.`,
      data: {
        asset_id: asset.id,
        source_segment_ids: planned.segment_ids,
        remaining_credits: remainingCredits,
      },
    });

    const output = await writeAsset({
      campaignId,
      planKey: planned.plan_key,
      type: planned.type,
      topic: planned.topic,
      purpose: planned.purpose,
      sources,
      goal: campaign.goal,
      audience: campaign.audience,
      brandVoice: campaign.brand_voice,
    });
    const saved = await saveWrittenAsset(asset.id, output);
    produced++;

    await emit({
      campaignId,
      agent: 'writing_agent',
      node: 'produce',
      level: 'tool',
      message: `${planned.plan_key}: saved ${labelForWrittenType(planned.type)} with ${output.grounding.length} verified source quote${output.grounding.length === 1 ? '' : 's'}.`,
      data: {
        asset_id: saved.id,
        plan_key: planned.plan_key,
        grounding_count: output.grounding.length,
        status: saved.status,
      },
    });
  }

  let videosProduced = 0;
  let videosReused = 0;
  for (const planned of plan.planned_assets) {
    if (planned.type !== 'short_video') continue;
    const asset = assetByKey.get(planned.plan_key);
    if (!asset) throw new Error(`No asset row exists for ${planned.plan_key}.`);

    if (asset.status === 'needs_review' && asset.media_url && asset.content) {
      videosReused++;
      continue;
    }
    if (asset.status !== 'planned' && asset.status !== 'generating') {
      throw new Error(`Video asset ${planned.plan_key} cannot be produced from status ${asset.status}.`);
    }
    if (campaign.has_video_stream === null || campaign.source_duration_sec === null) {
      throw new Error('Clip production reached without probed source media facts.');
    }

    const remainingCredits = await beginAssetGeneration(asset.id, planned.credits);
    await emit({
      campaignId,
      agent: 'clip_producer',
      node: 'produce',
      level: 'tool',
      message: `${planned.plan_key}: reserved ${planned.credits} credits and began the ${campaign.has_video_stream ? 'video' : 'audio-only caption-card'} media path.`,
      data: {
        asset_id: asset.id,
        source_segment_ids: planned.segment_ids,
        has_video_stream: campaign.has_video_stream,
        remaining_credits: remainingCredits,
      },
    });

    const output = await produceClip({
      campaignId,
      planKey: planned.plan_key,
      segmentIds: planned.segment_ids,
      topic: planned.topic,
      purpose: planned.purpose,
      maxVideoSeconds: campaign.max_video_seconds,
      sourceDurationSec: Number(campaign.source_duration_sec),
      hasVideoStream: campaign.has_video_stream,
      goal: campaign.goal,
      audience: campaign.audience,
      brandVoice: campaign.brand_voice,
    });
    const saved = await saveVideoAsset(asset.id, output);
    videosProduced++;

    await emit({
      campaignId,
      agent: 'clip_producer',
      node: 'produce',
      level: 'tool',
      message: `${planned.plan_key}: rendered and uploaded ${output.durationSec.toFixed(2)}s vertical MP4 after ${output.boundaryAdjustments} boundary adjustment${output.boundaryAdjustments === 1 ? '' : 's'}.`,
      data: {
        asset_id: saved.id,
        clip_start: output.clipStart,
        clip_end: output.clipEnd,
        duration_sec: output.durationSec,
        inspection: output.inspection,
        media_url: output.mediaUrl,
      },
    });
  }

  const writtenSummary = `${produced} written asset${produced === 1 ? '' : 's'} generated${reused ? `, ${reused} reused` : ''}`;
  const videoSummary = `${videosProduced} clip${videosProduced === 1 ? '' : 's'} rendered${videosReused ? `, ${videosReused} reused` : ''}`;
  return {
    next: 'critique',
    reason: `Production complete: ${writtenSummary}; ${videoSummary}. Every clip boundary is word-aligned and every render was checked against its requested duration within 100 ms.`,
  };
};

/** The registry the executor walks. Later phases add their nodes here and to the
 * mermaid diagram in `MVP.md` section 6 in the same commit. */
export const NODES: Partial<Record<NodeId, NodeFn>> = {
  ingest,
  transcribe,
  analyze,
  strategize,
  director_review_plan: directorReviewPlan,
  await_strategy_approval: awaitStrategyApproval,
  produce,
};

function isWrittenType(type: string): type is WrittenAssetType {
  return type === 'x_thread' || type === 'linkedin_post';
}

function labelForWrittenType(type: WrittenAssetType): string {
  return type === 'x_thread' ? 'X thread' : 'LinkedIn post';
}

async function assertReadable(path: string): Promise<void> {
  const size = await sizeOf(path);
  if (size === null) throw new Error(`File not found: ${path}`);
  if (size === 0) throw new Error(`File is empty: ${path}`);
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
