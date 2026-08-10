import { mkdir, stat } from 'node:fs/promises';
import type { AssetRow, SegmentRow } from '@/lib/db/client';
import type { Json } from '@/lib/db/database.types';
import { CriticSchema, critiqueAsset, decideCritic, type CriticReview } from '@/lib/agents/critic';
import { reviewStrategy } from '@/lib/agents/director';
import { analyzeSource } from '@/lib/agents/source-analyst';
import {
  CREDIT_COST,
  createStrategy,
  selectAlternative,
  type PlannedAsset,
} from '@/lib/agents/strategist';
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
  abandonAsset,
  beginAssetGeneration,
  beginAssetRevision,
  countSegments,
  ensurePlannedAssets,
  getAlternativeRun,
  getCampaignAssets,
  getCriticRun,
  getDirectorReview,
  getLatestReview,
  getLatestStrategy,
  getRevisionRequest,
  getSegments,
  getTranscript,
  getUnusedSegments,
  hasTranscript,
  markAssetPassed,
  markAssetRejected,
  markStrategyApproved,
  planFromStrategy,
  prepareAssetRevision,
  recordReview,
  replacePlannedAsset,
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
 * `strategize`, `director_review_plan`, and the first gate (Phase 3), grounded
 * writing (Phase 4), the Clip Producer (Phase 5), and the Critic loop (Phase 6).
 * The Campaign Reviewer frontier remains absent from the registry rather than
 * stubbed, so `run.ts` stops cleanly when it reaches it. A plausible empty stub
 * is worse than a missing entry because it makes an unbuilt phase look complete.
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
 * Produce exactly one asset, then hand it to the Critic. Keeping the unit of
 * work this small is what makes the revision edge visible and resumable: a
 * worker crash never needs to guess which item in a bulk sweep was being judged.
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
  const assetByKey = new Map(assets.map((asset) => [asset.plan_key, asset]));
  const planned = plan.planned_assets.find((candidate) => {
    const asset = assetByKey.get(candidate.plan_key);
    return asset && ACTIVE_ASSET_STATUSES.has(asset.status);
  });

  if (!planned) {
    return {
      next: 'campaign_review',
      reason: 'Every planned asset has passed, been abandoned, or been rejected. The portfolio is ready for Campaign Reviewer review.',
    };
  }

  const asset = assetByKey.get(planned.plan_key);
  if (!asset) throw new Error(`No asset row exists for ${planned.plan_key}.`);

  if (asset.status === 'needs_review' && hasGeneratedOutput(asset, planned.type)) {
    return {
      next: 'critique',
      reason: `${planned.plan_key} already has durable output from an earlier run; sending it to the Critic without generating it again.`,
    };
  }
  if (asset.status !== 'planned' && asset.status !== 'revising' && asset.status !== 'generating') {
    throw new Error(`Asset ${planned.plan_key} cannot be produced from status ${asset.status}.`);
  }

  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sources = sourceInputs(planned, segmentById);
  const isRevision = asset.revision_count > 0 || asset.status === 'revising';
  const previousReview = isRevision ? await getLatestReview(asset.id) : null;
  const revisionFeedback = previousReview?.feedback ?? null;
  const remainingCredits = isRevision
    ? await beginAssetRevision(asset.id)
    : await beginAssetGeneration(asset.id, planned.credits);

  await emit({
    campaignId,
    agent: isWrittenType(planned.type) ? 'writing_agent' : 'clip_producer',
    node: 'produce',
    level: 'tool',
    message: isRevision
      ? `${planned.plan_key}: regenerating after Critic feedback and reserving 1 revision credit.`
      : `${planned.plan_key}: generating the first attempt and reserving ${planned.credits} credits.`,
    data: {
      asset_id: asset.id,
      source_segment_ids: planned.segment_ids,
      revision_count: asset.revision_count,
      revision_feedback: revisionFeedback,
      remaining_credits: remainingCredits,
    },
  });

  if (isWrittenType(planned.type)) {
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
      revisionFeedback,
    });
    const saved = await saveWrittenAsset(asset.id, output);
    await emit({
      campaignId,
      agent: 'writing_agent',
      node: 'produce',
      level: 'tool',
      message: `${planned.plan_key}: saved ${isRevision ? 'revised ' : ''}${labelForWrittenType(planned.type)} with ${output.grounding.length} verified source quote${output.grounding.length === 1 ? '' : 's'}.`,
      data: {
        asset_id: saved.id,
        plan_key: planned.plan_key,
        grounding_count: output.grounding.length,
        revision_count: saved.revision_count,
        status: saved.status,
      },
    });

    return {
      next: 'critique',
      reason: `${isRevision ? 'Regenerated' : 'Generated'} ${planned.plan_key}; the Critic will now judge the ${isRevision ? `revision ${asset.revision_count}` : 'first attempt'} in isolation.`,
    };
  }

  if (campaign.has_video_stream === null || campaign.source_duration_sec === null) {
    throw new Error('Clip production reached without probed source media facts.');
  }

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
    revisionFeedback,
  });
  const saved = await saveVideoAsset(asset.id, output);
  await emit({
    campaignId,
    agent: 'clip_producer',
    node: 'produce',
    level: 'tool',
    message: `${planned.plan_key}: rendered ${isRevision ? 'revised ' : ''}${output.durationSec.toFixed(2)}s vertical MP4 after ${output.boundaryAdjustments} boundary adjustment${output.boundaryAdjustments === 1 ? '' : 's'}.`,
    data: {
      asset_id: saved.id,
      clip_start: output.clipStart,
      clip_end: output.clipEnd,
      duration_sec: output.durationSec,
      inspection: output.inspection,
      media_url: output.mediaUrl,
      revision_count: saved.revision_count,
    },
  });

  return {
    next: 'critique',
    reason: `${isRevision ? 'Regenerated' : 'Generated'} ${planned.plan_key}; the Critic will now judge the ${isRevision ? `revision ${asset.revision_count}` : 'first attempt'} in isolation.`,
  };
};

/** Critique the one durable output left by `produce` and route by code. */
const critique: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;
  const assets = await getCampaignAssets(campaignId);
  const asset = latestAssetWithStatus(assets, 'needs_review');

  if (!asset) {
    const strategy = await getLatestStrategy(campaignId);
    if (!strategy) throw new Error('Critique reached without a saved strategy.');
    const plan = planFromStrategy(strategy);
    return {
      next: planHasActiveAssets(plan.planned_assets, assets) ? 'produce' : 'campaign_review',
      reason: planHasActiveAssets(plan.planned_assets, assets)
        ? 'No unreviewed output is present; production will resume with the next planned asset.'
        : 'All produced assets have a terminal Critic outcome. The portfolio is ready for Campaign Reviewer review.',
    };
  }
  if (!asset.content) throw new Error(`Asset ${asset.plan_key} has no content for the Critic.`);

  const segments = await getSegments(campaignId);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sources = sourceInputsForIds(asset.source_segment_ids, segmentById, asset.plan_key);
  const revisionIndex = asset.revision_count;

  let review: CriticReview | null = null;
  const savedReview = await getLatestReview(asset.id);
  if (savedReview?.revision_index === revisionIndex) {
    const parsed = CriticSchema.safeParse({
      scores: savedReview.scores,
      feedback: savedReview.feedback,
    });
    if (parsed.success) review = parsed.data;
  }

  if (!review) {
    const priorRun = await getCriticRun(campaignId, asset.id, revisionIndex);
    review =
      priorRun?.review ??
      (await critiqueAsset({
        campaignId,
        assetId: asset.id,
        planKey: asset.plan_key,
        type: asset.type as 'short_video' | 'x_thread' | 'linkedin_post',
        platform: asset.platform as 'tiktok' | 'x' | 'linkedin',
        hook: asset.hook,
        content: asset.content,
        sources,
        inspection: inspectionFromContent(asset.content),
        revisionIndex,
        goal: campaign.goal,
        audience: campaign.audience,
        brandVoice: campaign.brand_voice,
      }));
  }

  const routing = decideCritic(review.scores);
  const persisted = await recordReview(asset.id, {
    campaignId,
    scores: review.scores,
    feedback: review.feedback,
    decision: routing.decision,
    revisionIndex,
  });

  await emit({
    campaignId,
    agent: 'content_critic',
    node: 'critique',
    level: 'info',
    message: `${asset.plan_key}: Critic ${routing.decision} at ${routing.average.toFixed(2)} average (lowest ${routing.lowest.toFixed(2)}).`,
    data: {
      asset_id: asset.id,
      decision: routing.decision,
      scores: review.scores,
      average: routing.average,
      lowest: routing.lowest,
      revision_index: persisted.revision_index,
    },
  });

  if (routing.decision === 'PASS') {
    await markAssetPassed(asset.id);
    return {
      next: 'produce',
      reason: `Critic PASS for ${asset.plan_key}: ${routing.average.toFixed(2)} average with no score below 5. Moving to the next asset.`,
    };
  }

  if (routing.decision === 'REVISE') {
    if (asset.revision_count < env.maxRevisionsPerAsset) {
      const revised = await prepareAssetRevision(asset.id, asset.revision_count);
      return {
        next: 'produce',
        reason: `Critic REVISE for ${asset.plan_key}: ${review.feedback} Revision ${revised.revision_count} of ${env.maxRevisionsPerAsset} is queued.`,
      };
    }

    await emit({
      campaignId,
      agent: 'content_critic',
      node: 'critique',
      level: 'warn',
      message: `${asset.plan_key}: revision limit reached at ${env.maxRevisionsPerAsset}; the asset will be abandoned.`,
      data: { asset_id: asset.id, revision_count: asset.revision_count },
    });
    return {
      next: 'abandon_asset',
      reason: `Critic REVISE for ${asset.plan_key}, but all ${env.maxRevisionsPerAsset} revisions are already spent.`,
    };
  }

  await markAssetRejected(asset.id);
  return {
    next: 'select_alternative',
    reason: `Critic REJECT for ${asset.plan_key}: a score reached 3 or below. The rejected asset is preserved while the Strategist searches unused segments.`,
  };
};

/** Strategist selects a new source moment without erasing the rejected history. */
const selectAlternativeNode: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaign, campaignId } = ctx;
  const assets = await getCampaignAssets(campaignId);
  const rejected = await latestAssetWithDecision(assets, 'rejected', 'REJECT');
  if (!rejected) {
    return {
      next: 'produce',
      reason: 'No rejected asset is awaiting an alternative; resuming production.',
    };
  }

  const strategy = await getLatestStrategy(campaignId);
  if (!strategy) throw new Error('Alternative selection reached without a saved strategy.');
  const plan = planFromStrategy(strategy);
  const existingAlternative = plan.planned_assets.find(
    (asset) =>
      asset.plan_key !== rejected.plan_key &&
      asset.plan_key.startsWith(`${alternativeRoot(rejected.plan_key)}_alt_`),
  );
  if (existingAlternative) {
    return {
      next: 'produce',
      reason: `${existingAlternative.plan_key} already replaces rejected ${rejected.plan_key}; resuming its production.`,
    };
  }

  const original = plan.planned_assets.find((asset) => asset.plan_key === rejected.plan_key);
  if (!original) {
    throw new Error(`Rejected asset ${rejected.plan_key} is not present in strategy v${strategy.version}.`);
  }
  const review = await getLatestReview(rejected.id);
  if (!review || review.decision !== 'REJECT') {
    throw new Error(`Rejected asset ${rejected.plan_key} has no durable REJECT review.`);
  }

  const candidates = (await getUnusedSegments(campaignId)).filter(
    (segment) =>
      original.type !== 'short_video' ||
      Number(segment.end_time) - Number(segment.start_time) <= campaign.max_video_seconds,
  );
  if (candidates.length === 0) {
    await emit({
      campaignId,
      agent: 'content_strategist',
      node: 'select_alternative',
      level: 'warn',
      message: `No unused segment can replace ${rejected.plan_key}; the asset will be abandoned.`,
      data: { asset_id: rejected.id },
    });
    return {
      next: 'abandon_asset',
      reason: `No unused source segment is eligible for ${rejected.plan_key}; abandoning the rejected asset.`,
    };
  }

  const priorSelection = await getAlternativeRun(campaignId, rejected.plan_key);
  const selection =
    priorSelection ??
    (await selectAlternative({
      campaignId,
      planKey: rejected.plan_key,
      rejectedTopic: original.topic,
      rejectionFeedback: review.feedback,
      assetType: original.type,
      candidates,
      goal: campaign.goal,
      audience: campaign.audience,
      brandVoice: campaign.brand_voice,
    }));
  const chosen = candidates.find((candidate) => candidate.id === selection.segment_id);
  if (!chosen) throw new Error(`Alternative selection returned unknown segment ${selection.segment_id}.`);

  const replacement: PlannedAsset = {
    ...original,
    plan_key: nextAlternativePlanKey(rejected.plan_key, assets),
    topic: chosen.topic,
    segment_ids: [chosen.id],
    credits: CREDIT_COST[original.type],
  };
  await replacePlannedAsset(strategy, rejected.plan_key, replacement);
  await emit({
    campaignId,
    agent: 'content_strategist',
    node: 'select_alternative',
    level: 'tool',
    message: `Strategist replaced ${rejected.plan_key} with ${replacement.plan_key} from unused segment ${chosen.id}: ${selection.reasoning}`,
    data: {
      rejected_asset_id: rejected.id,
      rejected_plan_key: rejected.plan_key,
      replacement_plan_key: replacement.plan_key,
      replacement_segment_id: chosen.id,
    },
  });

  return {
    next: 'produce',
    reason: `Strategist found an unused alternative for ${rejected.plan_key}: ${replacement.plan_key} uses “${chosen.topic}”.`,
  };
};

/** Exclude a weak asset after its revision or alternative path is exhausted. */
const abandonAssetNode: NodeFn = async (ctx): Promise<NodeResult> => {
  const { campaignId } = ctx;
  const assets = await getCampaignAssets(campaignId);
  const target =
    (await latestAssetWithDecision(assets, 'needs_review', 'REVISE', env.maxRevisionsPerAsset)) ??
    (await latestAssetWithDecision(assets, 'rejected', 'REJECT'));

  if (!target) {
    return {
      next: 'produce',
      reason: 'The current asset was already abandoned by an earlier attempt; checking for remaining production work.',
    };
  }

  const abandoned = await abandonAsset(target.id);
  await emit({
    campaignId,
    agent: 'system',
    node: 'abandon_asset',
    level: 'warn',
    message: `Abandoned ${abandoned.plan_key}; rejected and abandoned assets are excluded from the final package.`,
    data: { asset_id: abandoned.id, plan_key: abandoned.plan_key, status: abandoned.status },
  });
  return {
    next: 'produce',
    reason: `Abandoned ${abandoned.plan_key} after its Critic path could not produce a shippable asset.`,
  };
};

/** The registry the executor walks. The Campaign Reviewer frontier remains
 * intentionally absent until Phase 7; reaching it parks a truthful campaign. */
export const NODES: Partial<Record<NodeId, NodeFn>> = {
  ingest,
  transcribe,
  analyze,
  strategize,
  director_review_plan: directorReviewPlan,
  await_strategy_approval: awaitStrategyApproval,
  produce,
  critique,
  select_alternative: selectAlternativeNode,
  abandon_asset: abandonAssetNode,
};

const ACTIVE_ASSET_STATUSES = new Set(['planned', 'generating', 'revising', 'needs_review']);

function hasGeneratedOutput(asset: AssetRow, type: PlannedAsset['type']): boolean {
  return asset.content !== null && (type !== 'short_video' || asset.media_url !== null);
}

function sourceInputs(
  planned: PlannedAsset,
  segmentById: Map<string, SegmentRow>,
): Array<{ id: string; startTime: number; endTime: number; transcript: string }> {
  return sourceInputsForIds(planned.segment_ids, segmentById, planned.plan_key);
}

function sourceInputsForIds(
  ids: string[],
  segmentById: Map<string, SegmentRow>,
  planKey: string,
): Array<{ id: string; startTime: number; endTime: number; transcript: string }> {
  return ids.map((id) => {
    const segment = segmentById.get(id);
    if (!segment) throw new Error(`Plan ${planKey} references missing segment ${id}.`);
    return {
      id: segment.id,
      startTime: Number(segment.start_time),
      endTime: Number(segment.end_time),
      transcript: segment.transcript,
    };
  });
}

function planHasActiveAssets(planned: PlannedAsset[], assets: AssetRow[]): boolean {
  const assetByKey = new Map(assets.map((asset) => [asset.plan_key, asset]));
  return planned.some((candidate) => {
    const asset = assetByKey.get(candidate.plan_key);
    return asset ? ACTIVE_ASSET_STATUSES.has(asset.status) : true;
  });
}

function latestAssetWithStatus(assets: AssetRow[], status: string): AssetRow | null {
  return [...assets]
    .filter((asset) => asset.status === status)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
}

async function latestAssetWithDecision(
  assets: AssetRow[],
  status: string,
  decision: 'REVISE' | 'REJECT',
  minimumRevisionCount?: number,
): Promise<AssetRow | null> {
  const candidates = [...assets]
    .filter((asset) => asset.status === status)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  for (const asset of candidates) {
    if (minimumRevisionCount !== undefined && asset.revision_count < minimumRevisionCount) continue;
    const review = await getLatestReview(asset.id);
    if (review?.decision === decision) return asset;
  }
  return null;
}

function inspectionFromContent(content: Json): Json | null {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  const inspection = (content as Record<string, Json | undefined>).inspection;
  return inspection ?? null;
}

function alternativeRoot(planKey: string): string {
  return planKey.replace(/_alt_\d+$/, '');
}

function nextAlternativePlanKey(planKey: string, assets: AssetRow[]): string {
  const root = alternativeRoot(planKey);
  let index = 1;
  while (assets.some((asset) => asset.plan_key === `${root}_alt_${index}`)) index++;
  return `${root}_alt_${index}`;
}

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
