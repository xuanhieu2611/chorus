/**
 * The tool layer: the ONLY path an agent takes to the world.
 *
 * Agents import from here and from nowhere else. No agent file imports the
 * Supabase client and no agent file calls the AI SDK directly (that goes through
 * `lib/llm/structured.ts`). Both rules exist so every action an agent takes is
 * automatically logged and shows up in the live UI, rather than depending on
 * somebody remembering to log it.
 *
 * Phase 1 exposed the transcript, Phase 2 added segments, and Phase 3 adds the
 * versioned strategy plus durable Director and human revision feedback. Video
 * and assets land with the agents that need them in Phases 4 and 5.
 */
export { getTranscript, hasTranscript, saveTranscript, type Transcript } from '@/lib/tools/transcript';
export {
  countSegments,
  getSegments,
  saveSegments,
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
