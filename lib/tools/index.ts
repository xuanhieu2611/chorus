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
 * reservation, and Phase 5 added draft inspection, subtitle, render, and upload tools.
 */
export { getTranscript, hasTranscript, saveTranscript, type Transcript } from '@/lib/tools/transcript';
export {
  countSegments,
  getSegments,
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
  saveStrategy,
  type RevisionRequest,
} from '@/lib/tools/strategies';
export {
  beginAssetGeneration,
  ensurePlannedAssets,
  getCampaignAssets,
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
