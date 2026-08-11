import type { AssetReviewView, AssetView } from '@/components/AssetCard';
import type { CampaignReviewView } from '@/components/CampaignReviewCard';
import type { StrategyView } from '@/components/StrategyPanel';
import type { EventStreamState, SegmentRow } from '@/components/useEventStream';
import type { CampaignEvent, EventLevel } from '@/lib/events/types';

export const DEMO_CAMPAIGN_ID = 'demo-zero-cost';

export const DEMO_STEPS = [
  { label: 'Source', note: 'Turn the episode into timestamped candidate moments.' },
  { label: 'Plan', note: 'Decide what is worth making before production begins.' },
  { label: 'Make', note: 'Produce one grounded asset at a time.' },
  { label: 'Review', note: 'Revise weak work and judge the portfolio as a set.' },
  { label: 'Ship', note: 'Pause for a final human decision.' },
  { label: 'Outputs', note: 'Inspect the finished campaign and its evidence.' },
] as const;

export const DEMO_MOMENTS = [
  { phase: 0, label: 'Campaign queued', note: 'The worker claims a durable graph position.', currentNode: null, status: 'queued', delayMs: 2200, gate: null },
  { phase: 0, label: 'Inspecting source', note: 'Ingest verifies the media before any agent spends tokens.', currentNode: 'ingest', status: 'ingesting', delayMs: 2800, gate: null },
  { phase: 0, label: 'Building transcript', note: 'Word timestamps become the evidence layer for every output.', currentNode: 'transcribe', status: 'transcribing', delayMs: 3200, gate: null },
  { phase: 0, label: 'Mapping the episode', note: 'The Source Analyst finds moments that can stand on their own.', currentNode: 'analyze', status: 'analyzing', delayMs: 3600, gate: null },
  { phase: 1, label: 'Planning the campaign', note: 'The Strategist gives every output a distinct campaign job.', currentNode: 'strategize', status: 'strategizing', delayMs: 3800, gate: null },
  { phase: 1, label: 'Director review', note: 'A separate judgment role challenges the plan.', currentNode: 'director_review_plan', status: 'reviewing_strategy', delayMs: 3200, gate: null },
  { phase: 1, label: 'Strategy approval', note: 'The graph parks before production until you approve.', currentNode: 'await_strategy_approval', status: 'awaiting_strategy_approval', delayMs: null, gate: 'strategy' },
  { phase: 2, label: 'Writing one grounded draft', note: 'Every claim maps back to an exact transcript quote.', currentNode: 'produce', status: 'producing', delayMs: 3800, gate: null },
  { phase: 3, label: 'First critique', note: 'The Critic finds a generic opening in the first draft.', currentNode: 'critique', status: 'critiquing', delayMs: 3400, gate: null },
  { phase: 3, label: 'Revision loop', note: 'Only the failed asset returns to production with specific feedback.', currentNode: 'produce', status: 'producing', delayMs: 3800, gate: null },
  { phase: 3, label: 'Second critique', note: 'The revised opening clears the quality checks.', currentNode: 'critique', status: 'critiquing', delayMs: 3400, gate: null },
  { phase: 2, label: 'Rendering the first clip', note: 'The graph moves to the next planned asset.', currentNode: 'produce', status: 'producing', delayMs: 3600, gate: null },
  { phase: 3, label: 'Clip passed', note: 'The clip clears its isolated Critic review.', currentNode: 'critique', status: 'critiquing', delayMs: 3000, gate: null },
  { phase: 2, label: 'Writing the leadership post', note: 'Production continues one asset at a time.', currentNode: 'produce', status: 'producing', delayMs: 3200, gate: null },
  { phase: 3, label: 'Post passed', note: 'Grounding, clarity, and payoff all pass.', currentNode: 'critique', status: 'critiquing', delayMs: 3000, gate: null },
  { phase: 2, label: 'Rendering the second clip', note: 'The last planned asset uses a second eval segment.', currentNode: 'produce', status: 'producing', delayMs: 3400, gate: null },
  { phase: 3, label: 'Final asset passed', note: 'All four assets now have a terminal Critic result.', currentNode: 'critique', status: 'critiquing', delayMs: 3000, gate: null },
  { phase: 3, label: 'Portfolio review', note: 'The Campaign Reviewer catches two assets making the same argument.', currentNode: 'campaign_review', status: 'reviewing_campaign', delayMs: 4200, gate: null },
  { phase: 3, label: 'Replanning the portfolio', note: 'A diversity score below 60 forces a replacement in code.', currentNode: 'replan', status: 'strategizing', delayMs: 3800, gate: null },
  { phase: 2, label: 'Producing the replacement', note: 'Passing work is reused and only the replacement is generated.', currentNode: 'produce', status: 'producing', delayMs: 3600, gate: null },
  { phase: 3, label: 'Replacement passed', note: 'The new clip clears the Critic on its first attempt.', currentNode: 'critique', status: 'critiquing', delayMs: 3000, gate: null },
  { phase: 3, label: 'Portfolio approved', note: 'The revised set is varied, grounded, and consistent.', currentNode: 'campaign_review', status: 'reviewing_campaign', delayMs: 3600, gate: null },
  { phase: 4, label: 'Final approval', note: 'The reviewed portfolio waits for your decision.', currentNode: 'await_final_approval', status: 'awaiting_final_approval', delayMs: null, gate: 'final' },
  { phase: 4, label: 'Packaging campaign', note: 'Finalize validates the passing set and assembles the export.', currentNode: 'finalize', status: 'finalizing', delayMs: 3600, gate: null },
  { phase: 5, label: 'Campaign complete', note: 'The finished outputs and their source evidence are ready.', currentNode: 'finalize', status: 'complete', delayMs: null, gate: null },
] as const;

const segments: SegmentRow[] = [
  segment('seg-ship', 742, 826, 'Why AI features fail after the prototype', 'Evaluation discipline, not model choice, separates demos from dependable products.', 'The model is rarely the reason your AI feature fails.', 9.1),
  segment('seg-evals', 1324, 1408, 'The ten-example eval habit', 'A small, repeatable test set turns vague quality complaints into product work.', 'Before you change the prompt, save ten failures.', 9.3),
  segment('seg-trust', 2110, 2192, 'Trust is an interface problem', 'Evidence and recovery paths make uncertainty legible to users.', 'Trust does not come from hiding uncertainty.', 8.8),
  segment('seg-feedback', 2472, 2544, 'The hidden cost of vague feedback', 'Teams move faster when reviewers name the failing example and the expected behavior.', 'Bad feedback is a tax on every AI iteration.', 8.9),
  {
    ...segment('seg-hype', 2835, 2902, 'The autonomous agent hype cycle', 'A broad market prediction with little evidence from the episode.', 'Agents will replace every workflow.', 6),
    context_deps: 'Depends on earlier market discussion.',
  },
];

const strategyV1: StrategyView = {
  id: 'strategy-demo-v1',
  version: 1,
  rationale: 'Lead with a sharp product belief, follow with a practice builders can use today, then widen the conversation to trust.',
  planned_assets: [
    plan('thread-ten-failures', 'x_thread', 'x', 'The ten-example eval habit', 'Give builders a saveable operating ritual.', 'seg-evals', 2),
    plan('clip-model-trap', 'short_video', 'tiktok', 'The model-choice trap', 'Create recognition with a contrarian diagnosis.', 'seg-ship', 3),
    plan('post-visible-trust', 'linkedin_post', 'linkedin', 'Make uncertainty visible', 'Start a product-leadership conversation about trust.', 'seg-trust', 2),
    plan('clip-eval-loop', 'short_video', 'tiktok', 'Build the eval before the fix', 'Turn the eval framework into a second short clip.', 'seg-evals', 3),
  ],
  rejected_topics: [
    { topic: 'The autonomous agent hype cycle', reason: 'Too broad for the episode evidence and too similar to current category commentary.', segment_ids: ['seg-hype'] },
  ],
  approved_by: 'human',
  created_at: '2026-08-11T17:04:00.000Z',
};

const strategyV2: StrategyView = {
  ...strategyV1,
  id: 'strategy-demo-v2',
  version: 2,
  rationale: 'Keep the three distinct passing assets and replace the repetitive eval clip with a feedback-focused moment.',
  planned_assets: [
    ...strategyV1.planned_assets.slice(0, 3),
    plan('clip-feedback-tax_v2', 'short_video', 'tiktok', 'The feedback tax', 'Add a distinct team-practice argument to the portfolio.', 'seg-feedback', 3),
  ],
  created_at: '2026-08-11T17:31:00.000Z',
};

const reviseReview = review('review-thread-r0', 'asset-thread', 'REVISE', 0, 6.4, 'Lead with the ten saved failures and make the payoff concrete.');
const passReview = review('review-thread-r1', 'asset-thread', 'PASS', 1, 8.8, null);

const assetThread: AssetView = {
  id: 'asset-thread', plan_key: 'thread-ten-failures', type: 'x_thread', platform: 'x', source_segment_ids: ['seg-evals'],
  hook: 'Before you touch the prompt, save ten failures.', media_url: null, duration_sec: null, status: 'passed', revision_count: 1,
  updated_at: '2026-08-11T17:18:00.000Z',
  content: { kind: 'x_thread', tweets: ['Before you touch the prompt, save ten failures. That habit turns an AI feature from a guessing game into product work.', 'Put them next to ten answers you would happily ship. You now have the beginning of an eval, not a folder of opinions.', 'Change one thing. Run the same examples. Keep the change only if the failures improve without breaking good cases.', 'The goal is a stable conversation about quality your whole team can join.'], grounding: [{ claim: 'A small saved set makes iteration measurable.', source_quote: 'Save ten failures and ten answers you would ship before you rewrite anything.' }] },
  reviews: [reviseReview, passReview],
};

const assetClipOne: AssetView = {
  id: 'asset-clip-one', plan_key: 'clip-model-trap', type: 'short_video', platform: 'tiktok', source_segment_ids: ['seg-ship'],
  hook: 'Your model is probably not the problem.', media_url: null, duration_sec: 38.6, status: 'passed', revision_count: 0,
  updated_at: '2026-08-11T17:21:00.000Z',
  content: { kind: 'short_video', caption: 'Teams keep swapping models when nobody agreed on what good looks like. A prototype can impress once. A product has to succeed repeatedly.', clip_start: 756.2, clip_end: 794.8, boundary_adjustments: 1, grounding: [{ claim: 'Teams often blame model choice before defining quality.', source_quote: 'We changed the model three times before we wrote down what a good answer was.' }] },
  reviews: [review('review-clip-one', 'asset-clip-one', 'PASS', 0, 8.7, null)],
};

const assetLinkedIn: AssetView = {
  id: 'asset-linkedin', plan_key: 'post-visible-trust', type: 'linkedin_post', platform: 'linkedin', source_segment_ids: ['seg-trust'],
  hook: 'Trust is not a model property. It is an interface decision.', media_url: null, duration_sec: null, status: 'passed', revision_count: 0,
  updated_at: '2026-08-11T17:24:00.000Z',
  content: { kind: 'linkedin_post', body: 'Trust is not a model property. It is an interface decision.\n\nPeople need to know what the system used, where it is unsure, and what they can do next.\n\nEvidence, recovery, and correction are not edge cases around the model. They are the experience.', grounding: [{ claim: 'Evidence and recovery are part of the product experience.', source_quote: 'If the interface shows its evidence and gives me a recovery path, uncertainty stops feeling like failure.' }] },
  reviews: [review('review-linkedin', 'asset-linkedin', 'PASS', 0, 9, null)],
};

const assetRepeatedClip: AssetView = {
  id: 'asset-clip-two', plan_key: 'clip-eval-loop', type: 'short_video', platform: 'tiktok', source_segment_ids: ['seg-evals'],
  hook: 'Build the eval before you build the fix.', media_url: null, duration_sec: 34.2, status: 'passed', revision_count: 0,
  updated_at: '2026-08-11T17:27:00.000Z',
  content: { kind: 'short_video', caption: 'One change, the same twenty examples, then a decision. That stops prompt work from becoming a debate about screenshots.', clip_start: 1341.1, clip_end: 1375.3, boundary_adjustments: 0, grounding: [{ claim: 'Run the same examples after each change.', source_quote: 'Change one thing and run the same twenty examples again.' }] },
  reviews: [review('review-clip-two', 'asset-clip-two', 'PASS', 0, 8.5, null)],
};

const assetReplacement: AssetView = {
  id: 'asset-feedback-clip', plan_key: 'clip-feedback-tax_v2', type: 'short_video', platform: 'tiktok', source_segment_ids: ['seg-feedback'],
  hook: 'Vague feedback is the hidden tax on AI teams.', media_url: null, duration_sec: 36.4, status: 'passed', revision_count: 0,
  updated_at: '2026-08-11T17:35:00.000Z',
  content: { kind: 'short_video', caption: 'Name the failing example and the behavior you expected. That turns feedback from taste into a test the team can act on.', clip_start: 2484.4, clip_end: 2520.8, boundary_adjustments: 1, grounding: [{ claim: 'Specific examples make feedback actionable.', source_quote: 'Show me the failing example and tell me what you expected instead.' }] },
  reviews: [review('review-feedback', 'asset-feedback-clip', 'PASS', 0, 8.9, null)],
};

const v1Assets = [assetThread, assetClipOne, assetLinkedIn, assetRepeatedClip];
const finalAssets = [assetClipOne, assetThread, assetLinkedIn, assetReplacement];

const reviewV1: CampaignReviewView = {
  id: 'campaign-review-v1', version: 1, decision: 'REPLAN', model_decision: 'REPLAN', effective_decision: 'REPLAN',
  scores: { asset_quality: 87, diversity: 54, audience_fit: 91, brand_consistency: 89, overall: 80.3 },
  problems: [{ issue: 'The thread and second clip repeat the same eval argument.', asset_plan_keys: ['thread-ten-failures', 'clip-eval-loop'] }],
  recommendations: strategyV1.planned_assets.map((asset) => asset.plan_key === 'clip-eval-loop'
    ? { action: 'replace', plan_key: asset.plan_key, replacement_topic: 'The hidden cost of vague feedback', replacement_segment_ids: ['seg-feedback'], replacement_reason: 'Adds a distinct team-practice argument.', prior_rejection_addressed: null }
    : { action: 'keep', plan_key: asset.plan_key, replacement_topic: null, replacement_segment_ids: [], replacement_reason: null, prior_rejection_addressed: null }),
};

const reviewV2: CampaignReviewView = {
  id: 'campaign-review-v2', version: 2, decision: 'APPROVE', model_decision: 'APPROVE', effective_decision: 'APPROVE',
  scores: { asset_quality: 89, diversity: 86, audience_fit: 92, brand_consistency: 90, overall: 89.2 },
  problems: [],
  recommendations: strategyV2.planned_assets.map((asset) => ({ action: 'keep', plan_key: asset.plan_key, replacement_topic: null, replacement_segment_ids: [], replacement_reason: null, prior_rejection_addressed: null })),
};

const eventSpecs: Array<{ moment: number; node: string; message: string; level: EventLevel; next?: string }> = [
  event(1, 'start', 'Campaign claimed by the worker.', 'decision', 'ingest'),
  event(1, 'ingest', 'Entering ingest.', 'info'),
  event(1, 'ingest', 'Source verified: 52m 18s video with a valid audio track.', 'tool'),
  event(2, 'ingest', 'Source is ready for transcription.', 'decision', 'transcribe'),
  event(2, 'transcribe', 'Entering transcribe.', 'info'),
  event(2, 'transcribe', 'Transcript complete: 8,742 words with word timestamps.', 'info'),
  event(3, 'transcribe', 'Timestamped transcript is ready for analysis.', 'decision', 'analyze'),
  event(3, 'analyze', 'Entering analyze.', 'info'),
  event(3, 'analyze', 'Found 5 candidate moments. Four are strong enough to stand alone.', 'info'),
  event(4, 'analyze', 'Source map is ready for campaign planning.', 'decision', 'strategize'),
  event(4, 'strategize', 'Entering strategize.', 'info'),
  event(4, 'strategize', 'Built a 4-output plan using 10 of 12 credits.', 'info'),
  event(5, 'strategize', 'The plan is ready for independent review.', 'decision', 'director_review_plan'),
  event(5, 'director_review_plan', 'Entering director review.', 'info'),
  event(5, 'director_review_plan', 'Checking evidence, topic overlap, and campaign roles.', 'info'),
  event(6, 'director_review_plan', 'APPROVE: every output has a clear campaign job.', 'decision', 'await_strategy_approval'),
  event(6, 'await_strategy_approval', 'Strategy is waiting for human approval.', 'info'),
  event(7, 'await_strategy_approval', 'Human approved strategy v1.', 'decision', 'produce'),
  event(7, 'produce', 'Entering produce.', 'info'),
  event(7, 'produce', 'Writing Agent grounded the X thread against one source segment.', 'tool'),
  event(8, 'produce', 'Generated thread-ten-failures for isolated critique.', 'decision', 'critique'),
  event(8, 'critique', 'Entering critique.', 'info'),
  event(8, 'critique', 'The opening is accurate, but it does not earn attention yet.', 'info'),
  event(9, 'critique', 'REVISE thread-ten-failures: lead with the ten saved failures.', 'decision', 'produce'),
  event(9, 'produce', 'Entering produce.', 'info'),
  event(9, 'produce', 'Rewrote only the failed thread with the Critic feedback.', 'info'),
  event(10, 'produce', 'The revision is ready for another isolated critique.', 'decision', 'critique'),
  event(10, 'critique', 'Entering critique.', 'info'),
  event(10, 'critique', 'PASS thread-ten-failures: 8.8/10 after one revision.', 'info'),
  event(11, 'critique', 'PASS thread-ten-failures. Moving to the next planned asset.', 'decision', 'produce'),
  event(11, 'produce', 'Entering produce.', 'info'),
  event(11, 'produce', 'Clip Producer rendered a 38.6 second vertical clip.', 'tool'),
  event(12, 'produce', 'Generated clip-model-trap for isolated critique.', 'decision', 'critique'),
  event(12, 'critique', 'Entering critique.', 'info'),
  event(12, 'critique', 'PASS clip-model-trap: strong hook and clean source support.', 'info'),
  event(13, 'critique', 'PASS clip-model-trap. Moving to the next planned asset.', 'decision', 'produce'),
  event(13, 'produce', 'Entering produce.', 'info'),
  event(13, 'produce', 'Writing Agent grounded the LinkedIn post.', 'tool'),
  event(14, 'produce', 'Generated post-visible-trust for isolated critique.', 'decision', 'critique'),
  event(14, 'critique', 'Entering critique.', 'info'),
  event(14, 'critique', 'PASS post-visible-trust: 9.0/10.', 'info'),
  event(15, 'critique', 'PASS post-visible-trust. Moving to the next planned asset.', 'decision', 'produce'),
  event(15, 'produce', 'Entering produce.', 'info'),
  event(15, 'produce', 'Clip Producer rendered the second planned clip.', 'tool'),
  event(16, 'produce', 'Generated clip-eval-loop for isolated critique.', 'decision', 'critique'),
  event(16, 'critique', 'Entering critique.', 'info'),
  event(16, 'critique', 'PASS clip-eval-loop: 8.5/10.', 'info'),
  event(17, 'critique', 'PASS clip-eval-loop. All planned assets are terminal.', 'decision', 'campaign_review'),
  event(17, 'campaign_review', 'Entering campaign review.', 'info'),
  event(17, 'campaign_review', 'Diversity is 54/100. The thread and second clip repeat one argument.', 'info'),
  event(18, 'campaign_review', 'REPLAN: replace clip-eval-loop with the feedback segment.', 'decision', 'replan'),
  event(18, 'replan', 'Entering replan.', 'info'),
  event(18, 'replan', 'Saved strategy v2. Three passing assets stay reusable.', 'info'),
  event(19, 'replan', 'Strategy v2 needs one replacement asset.', 'decision', 'produce'),
  event(19, 'produce', 'Entering produce.', 'info'),
  event(19, 'produce', 'Clip Producer rendered clip-feedback-tax_v2.', 'tool'),
  event(20, 'produce', 'Generated the replacement for isolated critique.', 'decision', 'critique'),
  event(20, 'critique', 'Entering critique.', 'info'),
  event(20, 'critique', 'PASS clip-feedback-tax_v2: 8.9/10.', 'info'),
  event(21, 'critique', 'PASS replacement. The revised portfolio is ready.', 'decision', 'campaign_review'),
  event(21, 'campaign_review', 'Entering campaign review.', 'info'),
  event(21, 'campaign_review', 'Diversity improved from 54 to 86.', 'info'),
  event(22, 'campaign_review', 'APPROVE: the portfolio is ready for a human decision.', 'decision', 'await_final_approval'),
  event(22, 'await_final_approval', 'Campaign is waiting for final approval.', 'info'),
  event(23, 'await_final_approval', 'Human approved the campaign.', 'decision', 'finalize'),
  event(23, 'finalize', 'Entering finalize.', 'info'),
  event(23, 'finalize', 'Validating the passing set and assembling the export.', 'info'),
  event(24, 'finalize', 'Campaign package complete with 4 approved outputs.', 'decision', 'done'),
];

const events = eventSpecs.map(({ moment, node, message, level, next }, index): CampaignEvent & { moment: number } => ({
  moment,
  id: index + 1,
  campaign_id: DEMO_CAMPAIGN_ID,
  agent_run_id: null,
  agent: agentFor(node, message),
  node,
  level,
  message,
  data: next ? { next } : null,
  created_at: new Date(Date.UTC(2026, 7, 11, 17, index)).toISOString(),
}));

export function demoStream(momentIndex: number): EventStreamState {
  const bounded = Math.max(0, Math.min(DEMO_MOMENTS.length - 1, momentIndex));
  const moment = DEMO_MOMENTS[bounded];
  const visibleEvents = events.filter((item) => item.moment <= bounded);
  const currentEventIds = new Set(visibleEvents.filter((item) => item.moment === bounded).map((item) => item.id));

  return {
    campaign: {
      id: DEMO_CAMPAIGN_ID,
      title: 'The craft of dependable AI',
      goal: 'Grow an audience of product-minded AI builders with practical, evidence-backed ideas.',
      status: moment.status,
      current_node: moment.currentNode,
      completion_mode: bounded === DEMO_MOMENTS.length - 1 ? 'reviewer_approved' : null,
      completion_note: null,
      source_duration_sec: 3138,
      has_video_stream: true,
      cost_usd: 0,
      credits_spent: bounded < 7 ? 0 : 10,
      credit_budget: 12,
      portfolio_replan_count: bounded >= 18 ? 1 : 0,
      portfolio_replan_limit: 2,
      error: null,
    },
    transcript: bounded >= 2 ? { language: 'en', provider: 'mock transcript', word_count: 8742 } : null,
    segments: bounded >= 3 ? segments : [],
    strategy: bounded >= 18 ? strategyV2 : bounded >= 4 ? strategyV1 : null,
    campaignReview: bounded >= 21 ? reviewV2 : bounded >= 17 ? reviewV1 : null,
    assets: assetsForMoment(bounded),
    events: visibleEvents,
    liveEventIds: currentEventIds,
    cursor: visibleEvents.at(-1)?.id ?? 0,
    status: 'connected',
    error: null,
    retry: () => {},
  };
}

function assetsForMoment(moment: number): AssetView[] {
  if (moment < 7) return [];
  if (moment === 7 || moment === 8) return [draft(assetThread)];
  if (moment === 9) return [{ ...assetThread, status: 'revising', reviews: [reviseReview] }];
  if (moment === 10) return [assetThread];
  if (moment === 11) return [assetThread, draft(assetClipOne)];
  if (moment === 12) return [assetThread, assetClipOne];
  if (moment === 13) return [assetThread, assetClipOne, draft(assetLinkedIn)];
  if (moment === 14) return [assetThread, assetClipOne, assetLinkedIn];
  if (moment === 15) return [assetThread, assetClipOne, assetLinkedIn, draft(assetRepeatedClip)];
  if (moment < 19) return v1Assets;
  if (moment === 19) return [assetThread, assetClipOne, assetLinkedIn, draft(assetReplacement)];
  return finalAssets;
}

function draft(asset: AssetView): AssetView {
  return { ...asset, status: 'generating', reviews: [] };
}

function segment(id: string, start: number, end: number, topic: string, summary: string, hook: string, standalone: number): SegmentRow {
  return {
    id, start_time: start, end_time: end, topic, summary,
    content_type: 'framework', energy: 8.4, standalone_score: standalone, novelty_score: 8.7,
    potential_hooks: [hook], context_deps: null,
  };
}

function plan(
  planKey: string,
  type: 'short_video' | 'x_thread' | 'linkedin_post',
  platform: 'tiktok' | 'x' | 'linkedin',
  topic: string,
  purpose: string,
  segmentId: string,
  credits: number,
) {
  return { plan_key: planKey, type, platform, topic, purpose, segment_ids: [segmentId], credits };
}

function review(id: string, assetId: string, decision: AssetReviewView['decision'], revisionIndex: number, score: number, blockingFeedback: string | null): AssetReviewView {
  return {
    id, asset_id: assetId, reviewer_agent: 'content_critic',
    scores: { hook: score, clarity: score + 0.2, standalone: score - 0.1, originality: score - 0.2, audience_fit: score + 0.1, payoff: score },
    required_checks: { brief_compliant: true, source_supported: true, standalone: true, payoff_delivered: decision === 'PASS' },
    blocking_feedback: blockingFeedback,
    polish_feedback: decision === 'PASS' ? 'Tighten one transition if time allows.' : null,
    grounding_audit: [{ claim: 'The core claim is supported by the selected quote.', supported: true, overstates_source: false, reason: 'The draft preserves the source meaning.' }],
    grounding_audit_passed: true,
    materially_contradicted: false,
    feedback: blockingFeedback ?? 'Ready to publish.',
    decision,
    revision_index: revisionIndex,
    created_at: '2026-08-11T17:18:00.000Z',
  };
}

function event(moment: number, node: string, message: string, level: EventLevel, next?: string) {
  return { moment, node, message, level, next };
}

function agentFor(node: string, message: string): string {
  if (node === 'analyze') return 'source_analyst';
  if (node === 'strategize' || node === 'replan') return 'content_strategist';
  if (node === 'director_review_plan') return 'content_director';
  if (node === 'critique') return 'content_critic';
  if (node === 'campaign_review') return 'campaign_reviewer';
  if (node === 'produce') return message.includes('Clip') || message.includes('clip-') ? 'clip_producer' : 'writing_agent';
  return 'system';
}
