/**
 * The tool layer: the ONLY path an agent takes to the world.
 *
 * Agents import from here and from nowhere else. No agent file imports the
 * Supabase client and no agent file calls the AI SDK directly (that goes through
 * `lib/llm/structured.ts`). Both rules exist so every action an agent takes is
 * automatically logged and shows up in the live UI, rather than depending on
 * somebody remembering to log it.
 *
 * Phase 1 exposed the transcript, Phase 2 added segments, Phase 3 added the
 * versioned strategy, Phase 4 added durable assets with atomic credit
 * reservation, Phase 5 added draft inspection, subtitle, render, and upload tools,
 * and Phase 6 added Critic reviews, revision transitions, and alternative segments.
 * Phase 7 adds the portfolio review, durable replan memory, and final approval
 * feedback reads.
 */
export { getTranscript, hasTranscript, saveTranscript, type Transcript } from '@/lib/tools/transcript';
export {
  countSegments,
  getSegments,
  getUnusedSegments,
  readSegment,
  saveSegments,
  type ReadSegmentResult,
  type SegmentFilter,
} from '@/lib/tools/segments';
export {
  getDirectorReview,
  getLatestStrategy,
  getRevisionRequest,
  markStrategyApproved,
  planFromStrategy,
  replacePlannedAsset,
  saveStrategy,
  type RevisionRequest,
} from '@/lib/tools/strategies';
export {
  abandonAsset,
  beginAssetGeneration,
  beginAssetRevision,
  ensurePlannedAssets,
  getAsset,
  getCampaignAssets,
  markAssetPassed,
  markAssetRejected,
  markAssetReplaced,
  prepareAssetRevision,
  saveVideoAsset,
  saveWrittenAsset,
  type AssetStatus,
} from '@/lib/tools/assets';
export {
  extractVideo,
  generateSubtitles,
  getCampaignMedia,
  inspectRenderedVideo,
  loadFrameImages,
  localMediaPath,
  renderVerticalVideo,
  uploadAsset,
} from '@/lib/tools/video';
export {
  getAlternativeRun,
  getCampaignReview,
  getCampaignReviewRun,
  getFinalApprovalFeedback,
  getFinalApprovalProvenance,
  getLatestCampaignReview,
  getReplanRun,
  recordCampaignReview,
  getCriticRun,
  getLatestReview,
  recordReview,
  type RecordReviewInput,
} from '@/lib/tools/reviews';
export {
  chargeCampaignTransition,
  type ChargeTransitionInput,
  type ChargeTransitionResult,
} from '@/lib/tools/transitions';
