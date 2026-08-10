/**
 * The tool layer: the ONLY path an agent takes to the world.
 *
 * Agents import from here and from nowhere else. No agent file imports the
 * Supabase client and no agent file calls the AI SDK directly (that goes through
 * `lib/llm/structured.ts`). Both rules exist so every action an agent takes is
 * automatically logged and shows up in the live UI, rather than depending on
 * somebody remembering to log it.
 *
 * Phase 1 exposes the transcript. Segments, video, and assets land with the
 * agents that need them in Phases 2, 4, and 5.
 */
export { getTranscript, hasTranscript, saveTranscript, type Transcript } from '@/lib/tools/transcript';
